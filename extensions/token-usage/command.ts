import {
    BorderedLoader,
    type ExtensionCommandContext,
    type Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import type { TokenUsageOverlayResult } from './overlay.ts';
import { TokenReportOverlay } from './overlay.ts';
import type { TokenReportProvider } from './provider.ts';
import type { TokenReport } from './types.ts';

interface ReportLoader extends Component {
    readonly signal: AbortSignal;
    onAbort: (() => void) | undefined;
}

export interface TokensHandlerDependencies {
    createLoader?: (tui: TUI, theme: Theme, message: string) => ReportLoader;
    now?: () => Date;
}

type LoadResult =
    | { status: 'loaded'; report: TokenReport }
    | { status: 'cancelled' }
    | { status: 'failed' };

const cancelledResult = (): LoadResult => ({ status: 'cancelled' });
const failedResult = (): LoadResult => ({ status: 'failed' });

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
    const createLoader =
        dependencies.createLoader ??
        ((tui: TUI, theme: Theme, message: string) => new BorderedLoader(tui, theme, message));
    const now = dependencies.now ?? (() => new Date());

    return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (ctx.mode !== 'tui') return;
        if (active) return;
        active = true;

        try {
            let result: LoadResult;
            let loaderSignal: AbortSignal | undefined;
            try {
                result = await ctx.ui.custom<LoadResult>((tui, theme, _keybindings, done) => {
                    const loader = createLoader(tui, theme, 'Loading token usage...');
                    loaderSignal = loader.signal;
                    let completed = false;
                    const finish = (value: LoadResult): void => {
                        if (completed) return;
                        completed = true;
                        loader.onAbort = undefined;
                        done(value);
                    };

                    loader.onAbort = () => finish(cancelledResult());

                    const load = async (): Promise<void> => {
                        try {
                            await waitForIdleOrAbort(() => ctx.waitForIdle(), loader.signal);
                            loader.signal.throwIfAborted();

                            const cutoff = now();
                            const sessionManager = ctx.sessionManager;
                            const report = await provider.load({
                                now: cutoff,
                                signal: loader.signal,
                                currentSession: {
                                    id: sessionManager.getSessionId(),
                                    file: sessionManager.getSessionFile(),
                                    directory: sessionManager.getSessionDir(),
                                    entries: [...sessionManager.getEntries()],
                                },
                            });

                            finish(
                                loader.signal.aborted
                                    ? cancelledResult()
                                    : { status: 'loaded', report }
                            );
                        } catch {
                            finish(loader.signal.aborted ? cancelledResult() : failedResult());
                        }
                    };

                    void load();
                    return loader;
                });
            } catch {
                result = loaderSignal?.aborted ? cancelledResult() : failedResult();
            }

            if (result.status === 'cancelled') return;
            if (result.status === 'failed') {
                ctx.ui.notify('Unable to load token report.', 'error');
                return;
            }

            await ctx.ui.custom<TokenUsageOverlayResult>(
                (tui, theme, keybindings, done) =>
                    new TokenReportOverlay(result.report, theme, keybindings, done, () => ({
                        columns: tui.terminal.columns,
                        rows: tui.terminal.rows,
                    })),
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
        } finally {
            active = false;
        }
    };
}
