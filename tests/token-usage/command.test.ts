import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { createTokensHandler } from '../../extensions/token-usage/command.ts';
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

class FakeLoader implements Component {
    readonly controller = new AbortController();
    readonly addEventListenerSpy = vi.spyOn(this.controller.signal, 'addEventListener');
    readonly removeEventListenerSpy = vi.spyOn(this.controller.signal, 'removeEventListener');
    onAbort: (() => void) | undefined;
    disposed = false;

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    abort(): void {
        this.controller.abort();
        this.onAbort?.();
    }

    render(): string[] {
        return ['loading'];
    }

    handleInput(data: string): void {
        if (data === '\x1b') this.abort();
    }

    invalidate(): void {}

    dispose(): void {
        this.disposed = true;
    }
}

interface ContextHarness {
    ctx: ExtensionCommandContext;
    notifications: Array<[string, string | undefined]>;
    custom: ReturnType<typeof vi.fn>;
    loaders: FakeLoader[];
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
    const loaders: FakeLoader[] = [];
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
                        requestRender: () => {},
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

                if (customOptions?.overlay) {
                    const close = () => component?.handleInput?.('\x1b');
                    if (autoCloseOverlay) close();
                    else pendingOverlayClosers.push(close);
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
        loaders,
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

function handlerWithFakeLoader(
    provider: TokenReportProvider,
    harness: ContextHarness,
    now = new Date('2025-02-03T04:05:06.000Z')
) {
    return createTokensHandler(provider, {
        now: () => now,
        createLoader: () => {
            const loader = new FakeLoader();
            harness.loaders.push(loader);
            return loader;
        },
    });
}

describe('createTokensHandler', () => {
    it.each(['rpc', 'print', 'json'] as const)('is inert in %s mode', async (mode) => {
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext(mode);

        await handlerWithFakeLoader(provider, harness)('', harness.ctx);

        expect(provider.load).not.toHaveBeenCalled();
        expect(harness.waitForIdle).not.toHaveBeenCalled();
        expect(harness.notifications).toEqual([]);
        expect(harness.custom).not.toHaveBeenCalled();
    });

    it('opens the loader immediately, then snapshots and loads only after idle', async () => {
        const idle = deferred<void>();
        const loading = deferred<typeof report>();
        const provider: TokenReportProvider = { load: vi.fn(() => loading.promise) };
        const harness = createContext('tui', { waitForIdle: () => idle.promise });
        const entriesAfterIdle = [{ type: 'custom', id: 'committed' }];
        const cutoff = new Date('2025-02-03T04:05:06.000Z');
        const pending = handlerWithFakeLoader(provider, harness, cutoff)('', harness.ctx);

        expect(harness.custom).toHaveBeenCalledTimes(1);
        expect(harness.loaders).toHaveLength(1);
        expect(provider.load).not.toHaveBeenCalled();
        expect(harness.sessionGetters.getEntries).not.toHaveBeenCalled();

        harness.setEntries(entriesAfterIdle);
        idle.resolve();
        await vi.waitFor(() => expect(provider.load).toHaveBeenCalledTimes(1));

        const request = vi.mocked(provider.load).mock.calls[0][0];
        expect(request).toMatchObject({
            now: cutoff,
            signal: harness.loaders[0].signal,
            currentSession: {
                id: 'current-id',
                file: '/sessions/current.jsonl',
                directory: '/sessions',
                entries: entriesAfterIdle,
            },
        });
        expect(request.currentSession.entries).not.toBe(entriesAfterIdle);
        expect(harness.custom).toHaveBeenCalledTimes(1);

        loading.resolve(report);
        await pending;

        expect(harness.custom).toHaveBeenCalledTimes(2);
        expect(harness.notifications).toEqual([]);
        expect(harness.loaders[0].disposed).toBe(true);
    });

    it('cancels and releases the idle-wait continuation immediately', async () => {
        const idle = deferred<void>();
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext('tui', { waitForIdle: () => idle.promise });
        const pending = handlerWithFakeLoader(provider, harness)('', harness.ctx);
        await vi.waitFor(() => expect(harness.waitForIdle).toHaveBeenCalledTimes(1));

        const loader = harness.loaders[0];
        loader.abort();
        await pending;
        await vi.waitFor(() => expect(loader.removeEventListenerSpy).toHaveBeenCalledTimes(1));

        const abortListener = loader.addEventListenerSpy.mock.calls.find(
            ([event]) => event === 'abort'
        )?.[1];
        expect(abortListener).toBeDefined();
        expect(loader.removeEventListenerSpy).toHaveBeenCalledWith('abort', abortListener);
        expect(loader.onAbort).toBeUndefined();
        expect(provider.load).not.toHaveBeenCalled();
        expect(harness.sessionGetters.getEntries).not.toHaveBeenCalled();
        expect(harness.notifications).toEqual([]);
        expect(harness.custom).toHaveBeenCalledTimes(1);

        // The abandoned underlying wait remains observed even if it rejects later.
        idle.reject(new Error('late idle failure'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(provider.load).not.toHaveBeenCalled();
    });

    it('does not open a stale report when cancellation races a provider that ignores abort', async () => {
        const loading = deferred<typeof report>();
        let request: TokenReportRequest | undefined;
        const provider: TokenReportProvider = {
            load: vi.fn((value) => {
                request = value;
                return loading.promise;
            }),
        };
        const harness = createContext('tui');
        const pending = handlerWithFakeLoader(provider, harness)('', harness.ctx);
        await vi.waitFor(() => expect(provider.load).toHaveBeenCalledTimes(1));

        harness.loaders[0].abort();
        await pending;

        expect(request?.signal.aborted).toBe(true);
        expect(harness.notifications).toEqual([]);
        expect(harness.custom).toHaveBeenCalledTimes(1);

        loading.resolve(report);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(harness.custom).toHaveBeenCalledTimes(1);
    });

    it('closes the loader and reports a provider failure once', async () => {
        const provider: TokenReportProvider = {
            load: vi.fn(async () => {
                throw new Error('boom');
            }),
        };
        const harness = createContext('tui');

        await handlerWithFakeLoader(provider, harness)('', harness.ctx);

        expect(harness.notifications).toEqual([['Unable to load token report.', 'error']]);
        expect(harness.custom).toHaveBeenCalledTimes(1);
        expect(harness.loaders[0].disposed).toBe(true);
    });

    it('treats idle-wait failure as the same generic fatal error', async () => {
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext('tui', {
            waitForIdle: async () => {
                throw new Error('idle failed');
            },
        });

        await handlerWithFakeLoader(provider, harness)('', harness.ctx);

        expect(provider.load).not.toHaveBeenCalled();
        expect(harness.notifications).toEqual([['Unable to load token report.', 'error']]);
    });

    it.each([
        [77, 40],
        [100, 18],
    ])(
        'keeps an undersized %s-column, %s-row terminal in the overlay lifecycle',
        async (columns, rows) => {
            const provider = { load: vi.fn(async () => report) };
            const harness = createContext('tui', { columns, rows });
            const handler = handlerWithFakeLoader(provider, harness);

            await handler('', harness.ctx);
            await handler('', harness.ctx);

            expect(harness.notifications).toEqual([]);
            expect(harness.custom).toHaveBeenCalledTimes(4);
        }
    );

    it('allows only one invocation while loading', async () => {
        const idle = deferred<void>();
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext('tui', { waitForIdle: () => idle.promise });
        const handler = handlerWithFakeLoader(provider, harness);

        const first = handler('', harness.ctx);
        await handler('', harness.ctx);

        expect(harness.custom).toHaveBeenCalledTimes(1);
        expect(harness.waitForIdle).toHaveBeenCalledTimes(1);

        harness.loaders[0].abort();
        await first;
        idle.resolve();
    });

    it('remains active until the report overlay closes', async () => {
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext('tui', { autoCloseOverlay: false });
        const handler = handlerWithFakeLoader(provider, harness);
        const first = handler('', harness.ctx);
        await vi.waitFor(() => expect(harness.custom).toHaveBeenCalledTimes(2));

        await handler('', harness.ctx);
        expect(provider.load).toHaveBeenCalledTimes(1);
        expect(harness.custom).toHaveBeenCalledTimes(2);

        harness.closeOverlay();
        await first;
    });
});
