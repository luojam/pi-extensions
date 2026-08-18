import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { createTokensHandler } from '../../extensions/token-usage/command.ts';
import { TokenReportOverlay } from '../../extensions/token-usage/overlay.ts';
import type {
    TokenReportProvider,
    TokenReportRequest,
} from '../../extensions/token-usage/provider.ts';
import { createSampleTokenReportProvider } from './sample-report-provider.ts';

const report = await createSampleTokenReportProvider().load();

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

interface ContextHarness {
    ctx: ExtensionCommandContext;
    notifications: Array<[string, string | undefined]>;
    custom: ReturnType<typeof vi.fn>;
    components: Component[];
    waitForIdle: ReturnType<typeof vi.fn>;
    sessionGetters: {
        getSessionId: ReturnType<typeof vi.fn>;
        getSessionFile: ReturnType<typeof vi.fn>;
        getSessionDir: ReturnType<typeof vi.fn>;
        getEntries: ReturnType<typeof vi.fn>;
    };
    setEntries(entries: readonly unknown[]): void;
    closeOverlay(): void;
}

function createContext(
    mode: ExtensionCommandContext['mode'],
    options: {
        columns?: number;
        rows?: number;
        waitForIdle?: () => Promise<void>;
        autoCloseOverlay?: boolean;
    } = {}
): ContextHarness {
    const notifications: Array<[string, string | undefined]> = [];
    const components: Component[] = [];
    const pendingOverlayClosers: Array<() => void> = [];
    let entries: readonly unknown[] = [];
    const sessionGetters = {
        getSessionId: vi.fn(() => 'current-id'),
        getSessionFile: vi.fn(() => '/sessions/current.jsonl' as string | undefined),
        getSessionDir: vi.fn(() => '/sessions'),
        getEntries: vi.fn(() => entries),
    };
    const waitForIdle = vi.fn(options.waitForIdle ?? (async () => {}));
    const columns = options.columns ?? 100;
    const rows = options.rows ?? 40;
    const autoCloseOverlay = options.autoCloseOverlay ?? true;

    const custom = vi.fn(
        async (
            factory: (
                tui: {
                    terminal: { columns: number; rows: number };
                    requestRender(): void;
                },
                theme: { bold(text: string): string; fg(color: string, text: string): string },
                keybindings: {
                    getKeys(keybinding: string): string[];
                    matches(data: string, keybinding: string): boolean;
                },
                done: (result: unknown) => void
            ) => Component,
            customOptions?: { overlay?: boolean }
        ) =>
            await new Promise((resolve) => {
                let completed = false;
                let component: Component | undefined;
                const done = (result: unknown) => {
                    if (completed) return;
                    completed = true;
                    (component as (Component & { dispose?(): void }) | undefined)?.dispose?.();
                    resolve(result);
                };
                component = factory(
                    {
                        terminal: { columns, rows },
                        requestRender: () => {
                            if (
                                autoCloseOverlay &&
                                component instanceof TokenReportOverlay &&
                                !component.loading
                            ) {
                                component.handleInput?.('\x1b');
                            }
                        },
                    },
                    {
                        bold: (text: string) => text,
                        fg: (_color: string, text: string) => text,
                    },
                    {
                        getKeys: () => ['escape'],
                        matches: (data: string) => data === '\x1b',
                    },
                    done
                );
                components.push(component);

                if (customOptions?.overlay && !autoCloseOverlay) {
                    pendingOverlayClosers.push(() => component?.handleInput?.('\x1b'));
                }
            })
    );

    const ctx = {
        mode,
        waitForIdle,
        sessionManager: sessionGetters,
        ui: {
            custom,
            notify: (message: string, type?: string) => notifications.push([message, type]),
        },
    } as unknown as ExtensionCommandContext;

    return {
        ctx,
        notifications,
        custom,
        components,
        waitForIdle,
        sessionGetters,
        setEntries(nextEntries) {
            entries = nextEntries;
        },
        closeOverlay() {
            pendingOverlayClosers.shift()?.();
        },
    };
}

function createHandler(provider: TokenReportProvider, now = new Date('2025-02-03T04:05:06.000Z')) {
    return createTokensHandler(provider, { now: () => now });
}

describe('createTokensHandler', () => {
    it.each(['rpc', 'print', 'json'] as const)('is inert in %s mode', async (mode) => {
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext(mode);

        await createHandler(provider)('', harness.ctx);

        expect(provider.load).not.toHaveBeenCalled();
        expect(harness.waitForIdle).not.toHaveBeenCalled();
        expect(harness.notifications).toEqual([]);
        expect(harness.custom).not.toHaveBeenCalled();
    });

    it('opens one modal with a loader, then replaces it after idle', async () => {
        const idle = deferred<void>();
        const loading = deferred<typeof report>();
        const provider: TokenReportProvider = { load: vi.fn(() => loading.promise) };
        const harness = createContext('tui', { waitForIdle: () => idle.promise });
        const entriesAfterIdle = [{ type: 'custom', id: 'committed' }];
        const cutoff = new Date('2025-02-03T04:05:06.000Z');
        const pending = createHandler(provider, cutoff)('', harness.ctx);

        expect(harness.custom).toHaveBeenCalledTimes(1);
        expect(harness.components[0]?.render(76).join('\n')).toContain('Loading token usage...');
        expect(provider.load).not.toHaveBeenCalled();
        expect(harness.sessionGetters.getEntries).not.toHaveBeenCalled();

        harness.setEntries(entriesAfterIdle);
        idle.resolve();
        await vi.waitFor(() => expect(provider.load).toHaveBeenCalledTimes(1));

        const overlay = harness.components[0] as TokenReportOverlay;
        const request = vi.mocked(provider.load).mock.calls[0][0];
        expect(request).toMatchObject({
            now: cutoff,
            signal: overlay.signal,
            currentSession: {
                id: 'current-id',
                file: '/sessions/current.jsonl',
                directory: '/sessions',
                entries: entriesAfterIdle,
            },
        });
        expect(request.currentSession.entries).not.toBe(entriesAfterIdle);

        loading.resolve(report);
        await pending;

        expect(harness.custom).toHaveBeenCalledTimes(1);
        expect(harness.notifications).toEqual([]);
    });

    it('cancels and releases the idle-wait continuation immediately', async () => {
        const idle = deferred<void>();
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext('tui', { waitForIdle: () => idle.promise });
        const pending = createHandler(provider)('', harness.ctx);
        await vi.waitFor(() => expect(harness.waitForIdle).toHaveBeenCalledTimes(1));

        const overlay = harness.components[0] as TokenReportOverlay;
        overlay.handleInput('\x1b');
        await pending;

        expect(overlay.signal.aborted).toBe(true);
        expect(provider.load).not.toHaveBeenCalled();
        expect(harness.sessionGetters.getEntries).not.toHaveBeenCalled();
        expect(harness.notifications).toEqual([]);

        // The abandoned underlying wait remains observed even if it rejects later.
        idle.reject(new Error('late idle failure'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(provider.load).not.toHaveBeenCalled();
    });

    it('does not show a stale report when cancellation races a provider that ignores abort', async () => {
        const loading = deferred<typeof report>();
        let request: TokenReportRequest | undefined;
        const provider: TokenReportProvider = {
            load: vi.fn((value) => {
                request = value;
                return loading.promise;
            }),
        };
        const harness = createContext('tui');
        const pending = createHandler(provider)('', harness.ctx);
        await vi.waitFor(() => expect(provider.load).toHaveBeenCalledTimes(1));

        (harness.components[0] as TokenReportOverlay).handleInput('\x1b');
        await pending;

        expect(request?.signal.aborted).toBe(true);
        expect(harness.notifications).toEqual([]);
        expect(harness.custom).toHaveBeenCalledTimes(1);

        loading.resolve(report);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(harness.custom).toHaveBeenCalledTimes(1);
    });

    it('shows a provider failure in the modal without a redundant notification', async () => {
        const provider: TokenReportProvider = {
            load: vi.fn(async () => {
                throw new Error('boom');
            }),
        };
        const harness = createContext('tui');

        await createHandler(provider)('', harness.ctx);

        expect(harness.notifications).toEqual([]);
        expect(harness.custom).toHaveBeenCalledTimes(1);
    });

    it('shows idle-wait failure in the modal without a redundant notification', async () => {
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext('tui', {
            waitForIdle: async () => {
                throw new Error('idle failed');
            },
        });

        await createHandler(provider)('', harness.ctx);

        expect(provider.load).not.toHaveBeenCalled();
        expect(harness.notifications).toEqual([]);
    });

    it.each([
        [77, 40],
        [100, 18],
    ])(
        'keeps an undersized %s-column, %s-row terminal in the overlay lifecycle',
        async (columns, rows) => {
            const provider = { load: vi.fn(async () => report) };
            const harness = createContext('tui', { columns, rows });
            const handler = createHandler(provider);

            await handler('', harness.ctx);
            await handler('', harness.ctx);

            expect(harness.notifications).toEqual([]);
            expect(harness.custom).toHaveBeenCalledTimes(2);
        }
    );

    it('allows only one invocation while loading', async () => {
        const idle = deferred<void>();
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext('tui', { waitForIdle: () => idle.promise });
        const handler = createHandler(provider);

        const first = handler('', harness.ctx);
        await handler('', harness.ctx);

        expect(harness.custom).toHaveBeenCalledTimes(1);
        expect(harness.waitForIdle).toHaveBeenCalledTimes(1);

        (harness.components[0] as TokenReportOverlay).handleInput('\x1b');
        await first;
        idle.resolve();
    });

    it('remains active until the loaded report modal closes', async () => {
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext('tui', { autoCloseOverlay: false });
        const handler = createHandler(provider);
        const first = handler('', harness.ctx);
        await vi.waitFor(() => expect(provider.load).toHaveBeenCalledTimes(1));
        await vi.waitFor(() =>
            expect(harness.components[0]?.render(76).join('\n')).toContain('Historical token usage')
        );

        await handler('', harness.ctx);
        expect(provider.load).toHaveBeenCalledTimes(1);
        expect(harness.custom).toHaveBeenCalledTimes(1);

        harness.closeOverlay();
        await first;
    });
});
