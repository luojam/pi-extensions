import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { createTokensHandler } from '../command.ts';
import type { TokenReportProvider } from '../provider.ts';
import { createSampleTokenReportProvider } from '../sample-report-provider.ts';

const report = await createSampleTokenReportProvider().load();

interface ContextHarness {
    ctx: ExtensionCommandContext;
    notifications: Array<[string, string | undefined]>;
    custom: ReturnType<typeof vi.fn>;
}

function createContext(
    mode: ExtensionCommandContext['mode'],
    columns = 100,
    rows = 40
): ContextHarness {
    const notifications: Array<[string, string | undefined]> = [];
    const custom = vi.fn(
        async (
            factory: (
                tui: { terminal: { columns: number; rows: number } },
                theme: { bold(text: string): string; fg(color: string, text: string): string },
                keybindings: {
                    getKeys(): string[];
                    matches(data: string): boolean;
                },
                done: (result: unknown) => void
            ) => unknown,
            options: unknown
        ) => {
            return await new Promise((resolve) => {
                let completed = false;
                const done = (result: unknown) => {
                    completed = true;
                    resolve(result);
                };
                const component = factory(
                    { terminal: { columns, rows } },
                    {
                        bold: (text: string) => text,
                        fg: (_color: string, text: string) => text,
                    },
                    {
                        getKeys: () => ['escape'],
                        matches: (data: string) => data === '\x1b',
                    },
                    done
                ) as { handleInput(data: string): void };

                // A fitting overlay remains mounted until its configured cancel input arrives.
                if (!completed) component.handleInput('\x1b');
                expect(options).toEqual({
                    overlay: true,
                    overlayOptions: {
                        anchor: 'center',
                        width: 76,
                        maxHeight: '100%',
                        margin: { top: 1, right: 2, bottom: 1, left: 2 },
                    },
                });
            });
        }
    );

    const ctx = {
        mode,
        ui: {
            custom,
            notify: (message: string, type?: string) => notifications.push([message, type]),
        },
    } as unknown as ExtensionCommandContext;

    return { ctx, notifications, custom };
}

describe('createTokensHandler', () => {
    it.each(['rpc', 'print', 'json'] as const)('is inert in %s mode', async (mode) => {
        const provider = { load: vi.fn(async () => report) };
        const harness = createContext(mode);

        await createTokensHandler(provider)('', harness.ctx);

        expect(provider.load).not.toHaveBeenCalled();
        expect(harness.notifications).toEqual([]);
        expect(harness.custom).not.toHaveBeenCalled();
    });

    it('waits for loading to finish before opening the UI', async () => {
        let resolveLoad: ((value: typeof report) => void) | undefined;
        const provider: TokenReportProvider = {
            load: () =>
                new Promise((resolve) => {
                    resolveLoad = resolve;
                }),
        };
        const harness = createContext('tui');
        const pending = createTokensHandler(provider)('', harness.ctx);

        expect(harness.custom).not.toHaveBeenCalled();

        resolveLoad?.(report);
        await pending;

        expect(harness.custom).toHaveBeenCalledTimes(1);
        expect(harness.notifications).toEqual([]);
    });

    it('reports provider failure once', async () => {
        const provider: TokenReportProvider = {
            load: vi.fn(async () => {
                throw new Error('boom');
            }),
        };
        const harness = createContext('tui');

        await createTokensHandler(provider)('', harness.ctx);

        expect(harness.notifications).toEqual([['Unable to load token report.', 'error']]);
        expect(harness.custom).not.toHaveBeenCalled();
    });

    it.each([
        [77, 40],
        [100, 18],
    ])(
        'keeps an undersized %s-column, %s-row terminal in the overlay lifecycle',
        async (columns, rows) => {
            const provider = { load: vi.fn(async () => report) };
            const harness = createContext('tui', columns, rows);
            const handler = createTokensHandler(provider);

            await handler('', harness.ctx);
            await handler('', harness.ctx);

            expect(harness.notifications).toEqual([]);
            expect(harness.custom).toHaveBeenCalledTimes(2);
        }
    );

    it('allows only one active invocation', async () => {
        let resolveLoad: ((value: typeof report) => void) | undefined;
        const provider: TokenReportProvider = {
            load: vi.fn(
                () =>
                    new Promise<typeof report>((resolve) => {
                        resolveLoad = resolve;
                    })
            ),
        };
        const harness = createContext('tui');
        const handler = createTokensHandler(provider);

        const first = handler('', harness.ctx);
        await handler('', harness.ctx);
        expect(provider.load).toHaveBeenCalledTimes(1);

        resolveLoad?.(report);
        await first;
    });
});
