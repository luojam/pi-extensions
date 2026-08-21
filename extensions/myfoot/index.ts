import { basename } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fetchUsageLimit, type UsageLimit } from './codex-usage.ts';
import { type FooterContextUsage, getFooterContextUsage } from './context-usage.ts';
import { getSpinnerFrame, renderFooter } from './footer.ts';

const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
const CONTEXT_REFRESH_INTERVAL_MS = 1_000;
const ACTIVE_REFRESH_INTERVAL_MS = 80;

export default function contextFooter(pi: ExtensionAPI) {
    let usageLimit: UsageLimit = { kind: 'message', text: 'Codex usage: loading…' };
    let requestFooterRender = () => {};
    let usageRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let contextRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let elapsedRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let refreshController: AbortController | undefined;
    let contextUsage: FooterContextUsage | undefined;
    let sessionName: string | undefined;
    let baseTitle = '';
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

    const refreshSessionMetadata = (ctx: ExtensionContext) => {
        const cwd = basename(ctx.sessionManager.getCwd());
        sessionName = ctx.sessionManager.getSessionName();
        baseTitle = sessionName ? `π - ${sessionName} - ${cwd}` : `π - ${cwd}`;
    };

    const refreshContextUsage = (ctx: ExtensionContext, render = true) => {
        if (!tuiSessionActive) return;
        contextUsage = getFooterContextUsage(ctx, pi);
        if (render) requestFooterRender();
    };

    const updateTitle = (ctx: ExtensionContext) => {
        const title =
            agentStartedAt === undefined
                ? baseTitle
                : `${getSpinnerFrame(getElapsedMs())} ${baseTitle}`;
        ctx.ui.setTitle(title);
    };

    const stopActiveRefresh = () => {
        if (contextRefreshTimer) clearInterval(contextRefreshTimer);
        contextRefreshTimer = undefined;
        if (elapsedRefreshTimer) clearInterval(elapsedRefreshTimer);
        elapsedRefreshTimer = undefined;
    };

    pi.on('session_start', (_event, ctx) => {
        if (usageRefreshTimer) clearInterval(usageRefreshTimer);
        usageRefreshTimer = undefined;
        stopActiveRefresh();
        elapsedMs = 0;
        agentStartedAt = undefined;
        contextUsage = undefined;
        sessionName = undefined;
        baseTitle = '';
        refreshController?.abort();
        refreshController = undefined;
        tuiSessionActive = ctx.mode === 'tui';
        if (!tuiSessionActive) return;

        refreshController = new AbortController();
        refreshSessionMetadata(ctx);
        refreshContextUsage(ctx, false);
        ctx.ui.setWorkingVisible(false);
        updateTitle(ctx);
        ctx.ui.setFooter((tui, theme, footerData) => {
            requestFooterRender = () => tui.requestRender();
            const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

            return {
                dispose: unsubscribe,
                invalidate() {},
                render: (width: number) => {
                    if (ctx.isIdle()) refreshContextUsage(ctx, false);

                    return renderFooter({
                        width,
                        theme,
                        footerData,
                        ctx,
                        pi,
                        usageLimit,
                        contextUsage,
                        sessionName,
                        elapsedMs: getElapsedMs(),
                        working: agentStartedAt !== undefined,
                    });
                },
            };
        });

        void refreshUsageLimit();
        usageRefreshTimer = setInterval(() => void refreshUsageLimit(), USAGE_REFRESH_INTERVAL_MS);
    });

    pi.on('agent_start', (_event, ctx) => {
        if (!tuiSessionActive || agentStartedAt !== undefined) return;

        elapsedMs = 0;
        agentStartedAt = performance.now();
        refreshContextUsage(ctx, false);
        contextRefreshTimer = setInterval(
            () => refreshContextUsage(ctx, false),
            CONTEXT_REFRESH_INTERVAL_MS
        );
        const refreshActiveUi = () => {
            requestFooterRender();
            updateTitle(ctx);
        };
        elapsedRefreshTimer = setInterval(refreshActiveUi, ACTIVE_REFRESH_INTERVAL_MS);
        refreshActiveUi();
    });

    pi.on('agent_settled', (_event, ctx) => {
        if (!tuiSessionActive || !ctx.isIdle()) return;

        if (agentStartedAt !== undefined) {
            elapsedMs = Math.max(0, performance.now() - agentStartedAt);
            agentStartedAt = undefined;
            stopActiveRefresh();
            refreshContextUsage(ctx, false);
            requestFooterRender();
            updateTitle(ctx);
        }

        void refreshUsageLimit();
    });

    pi.on('session_info_changed', (_event, ctx) => {
        if (!tuiSessionActive) return;
        refreshSessionMetadata(ctx);
        requestFooterRender();
        updateTitle(ctx);
    });

    pi.on('session_compact', (_event, ctx) => refreshContextUsage(ctx));
    pi.on('session_tree', (_event, ctx) => refreshContextUsage(ctx));
    pi.on('model_select', (_event, ctx) => refreshContextUsage(ctx));

    pi.on('session_shutdown', (_event, ctx) => {
        if (tuiSessionActive) {
            agentStartedAt = undefined;
            updateTitle(ctx);
        }
        tuiSessionActive = false;
        if (usageRefreshTimer) clearInterval(usageRefreshTimer);
        usageRefreshTimer = undefined;
        stopActiveRefresh();
        agentStartedAt = undefined;
        contextUsage = undefined;
        sessionName = undefined;
        baseTitle = '';
        refreshController?.abort();
        refreshController = undefined;
        latestRefresh++;
        requestFooterRender = () => {};
    });
}
