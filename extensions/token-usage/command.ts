import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { TokenUsageOverlayResult } from './overlay.ts';
import { TokenReportOverlay } from './overlay.ts';
import type { TokenReportProvider } from './provider.ts';

export interface TokensHandlerDependencies {
    now?: () => Date;
}

/** Wait without retaining the command continuation after loader cancellation. */
async function waitForIdleOrAbort(
    waitForIdle: () => Promise<void>,
    signal: AbortSignal
): Promise<void> {
    signal.throwIfAborted();

    let rejectAborted!: (reason?: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = reject;
    });
    const onAbort = (): void => rejectAborted(signal.reason);

    signal.addEventListener('abort', onAbort, { once: true });
    try {
        signal.throwIfAborted();
        const idle = Promise.resolve().then(waitForIdle);
        await Promise.race([idle, aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

export function createTokensHandler(
    provider: TokenReportProvider,
    dependencies: TokensHandlerDependencies = {}
) {
    let active = false;
    const now = dependencies.now ?? (() => new Date());

    return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (ctx.mode !== 'tui') return;
        if (active) return;
        active = true;

        try {
            try {
                await ctx.ui.custom<TokenUsageOverlayResult>(
                    (tui, theme, keybindings, done) => {
                        const overlay = new TokenReportOverlay(
                            undefined,
                            theme,
                            keybindings,
                            done,
                            () => ({
                                columns: tui.terminal.columns,
                                rows: tui.terminal.rows,
                            }),
                            () => tui.requestRender()
                        );

                        const load = async (): Promise<void> => {
                            try {
                                await waitForIdleOrAbort(() => ctx.waitForIdle(), overlay.signal);
                                overlay.signal.throwIfAborted();

                                const cutoff = now();
                                const sessionManager = ctx.sessionManager;
                                const report = await provider.load({
                                    now: cutoff,
                                    signal: overlay.signal,
                                    currentSession: {
                                        id: sessionManager.getSessionId(),
                                        file: sessionManager.getSessionFile(),
                                        directory: sessionManager.getSessionDir(),
                                        entries: [...sessionManager.getEntries()],
                                    },
                                });

                                overlay.setReport(report);
                            } catch {
                                if (!overlay.signal.aborted) overlay.fail();
                            }
                        };

                        void load();
                        return overlay;
                    },
                    {
                        overlay: true,
                        overlayOptions: {
                            anchor: 'center',
                            width: 76,
                            maxHeight: '100%',
                            margin: { top: 1, right: 2, bottom: 1, left: 2 },
                        },
                    }
                );
            } catch {
                // The overlay reports load failures in place.
            }
        } finally {
            active = false;
        }
    };
}
