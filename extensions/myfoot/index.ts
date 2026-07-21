import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fetchUsageLimit, type UsageLimit } from './codex-usage.ts';
import { renderFooter } from './footer.ts';

const REFRESH_INTERVAL_MS = 5 * 60_000;

export default function contextFooter(pi: ExtensionAPI) {
    let usageLimit: UsageLimit = { kind: 'message', text: 'Codex usage: loading…' };
    let requestFooterRender = () => {};
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let refreshController: AbortController | undefined;
    let tuiSessionActive = false;
    let latestRefresh = 0;

    const refreshUsageLimit = async () => {
        if (!tuiSessionActive) return;

        const refresh = ++latestRefresh;
        const nextUsageLimit = await fetchUsageLimit(refreshController?.signal);
        if (!tuiSessionActive || refresh !== latestRefresh) return;

        usageLimit = nextUsageLimit;
        requestFooterRender();
    };

    pi.on('session_start', (_event, ctx) => {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = undefined;
        refreshController?.abort();
        refreshController = undefined;
        tuiSessionActive = ctx.mode === 'tui';
        if (!tuiSessionActive) return;

        refreshController = new AbortController();
        ctx.ui.setFooter((tui, theme, footerData) => {
            requestFooterRender = () => tui.requestRender();
            const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

            return {
                dispose: unsubscribe,
                invalidate() {},
                render: (width: number) =>
                    renderFooter({ width, theme, footerData, ctx, pi, usageLimit }),
            };
        });

        void refreshUsageLimit();
        refreshTimer = setInterval(() => void refreshUsageLimit(), REFRESH_INTERVAL_MS);
    });

    pi.on('agent_settled', () => {
        if (tuiSessionActive) void refreshUsageLimit();
    });

    pi.on('session_shutdown', () => {
        tuiSessionActive = false;
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = undefined;
        refreshController?.abort();
        refreshController = undefined;
        latestRefresh++;
        requestFooterRender = () => {};
    });
}
