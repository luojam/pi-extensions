import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { TokenUsageOverlayResult } from './overlay.ts';
import { TokenReportOverlay } from './overlay.ts';
import type { TokenReportProvider } from './provider.ts';
import type { TokenReport } from './types.ts';

export function createTokensHandler(provider: TokenReportProvider) {
    let active = false;

    return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (ctx.mode !== 'tui') return;
        if (active) return;
        active = true;

        try {
            let report: TokenReport;
            try {
                report = await provider.load();
            } catch {
                ctx.ui.notify('Unable to load token report.', 'error');
                return;
            }

            await ctx.ui.custom<TokenUsageOverlayResult>(
                (tui, theme, keybindings, done) =>
                    new TokenReportOverlay(report, theme, keybindings, done, () => ({
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
