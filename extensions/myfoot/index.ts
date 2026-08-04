import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fetchUsageLimit, type UsageLimit } from './codex-usage.ts';
import { renderFooter } from './footer.ts';

const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
const ELAPSED_REFRESH_INTERVAL_MS = 1_000;

export default function contextFooter(pi: ExtensionAPI) {
    let usageLimit: UsageLimit = { kind: 'message', text: 'Codex usage: loading…' };
    let requestFooterRender = () => {};
    let usageRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let elapsedRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let refreshController: AbortController | undefined;
    let elapsedMs = 0;
    let agentStartedAt: number | undefined;
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

    const getElapsedMs = () =>
        agentStartedAt === undefined ? elapsedMs : Math.max(0, performance.now() - agentStartedAt);

    const stopElapsedRefresh = () => {
        if (elapsedRefreshTimer) clearInterval(elapsedRefreshTimer);
        elapsedRefreshTimer = undefined;
    };

    pi.on('session_start', (_event, ctx) => {
        if (usageRefreshTimer) clearInterval(usageRefreshTimer);
        usageRefreshTimer = undefined;
        stopElapsedRefresh();
        elapsedMs = 0;
        agentStartedAt = undefined;
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
                    renderFooter({
                        width,
                        theme,
                        footerData,
                        ctx,
                        pi,
                        usageLimit,
                        elapsedMs: getElapsedMs(),
                    }),
            };
        });

        void refreshUsageLimit();
        usageRefreshTimer = setInterval(() => void refreshUsageLimit(), USAGE_REFRESH_INTERVAL_MS);
    });

    pi.on('agent_start', () => {
        if (!tuiSessionActive || agentStartedAt !== undefined) return;

        elapsedMs = 0;
        agentStartedAt = performance.now();
        elapsedRefreshTimer = setInterval(() => requestFooterRender(), ELAPSED_REFRESH_INTERVAL_MS);
        requestFooterRender();
    });

    pi.on('agent_settled', (_event, ctx) => {
        if (!tuiSessionActive || !ctx.isIdle()) return;

        if (agentStartedAt !== undefined) {
            elapsedMs = Math.max(0, performance.now() - agentStartedAt);
            agentStartedAt = undefined;
            stopElapsedRefresh();
            requestFooterRender();
        }

        void refreshUsageLimit();
    });

    pi.on('session_shutdown', () => {
        tuiSessionActive = false;
        if (usageRefreshTimer) clearInterval(usageRefreshTimer);
        usageRefreshTimer = undefined;
        stopElapsedRefresh();
        agentStartedAt = undefined;
        refreshController?.abort();
        refreshController = undefined;
        latestRefresh++;
        requestFooterRender = () => {};
    });
}
