import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
    ExtensionAPI,
    ExtensionContext,
    ReadonlyFooterDataProvider,
    Theme,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { UsageLimit } from './codex-usage.ts';
import { getFooterContextUsage } from './context-usage.ts';

const USAGE_BAR_WIDTH = 10;

interface RenderFooterOptions {
    width: number;
    theme: Theme;
    footerData: ReadonlyFooterDataProvider;
    ctx: ExtensionContext;
    pi: ExtensionAPI;
    usageLimit: UsageLimit;
    elapsedMs: number;
}

export function renderFooter({
    width,
    theme,
    footerData,
    ctx,
    pi,
    usageLimit,
    elapsedMs,
}: RenderFooterOptions): string[] {
    const contentWidth = Math.max(0, width - 6);
    const lines = [
        frameLine(
            renderHeader(contentWidth, theme, footerData, ctx, pi, elapsedMs),
            width,
            theme,
            true
        ),
        frameLine(renderStats(contentWidth, theme, ctx, pi, usageLimit), width, theme, false),
    ];

    const statuses = [...footerData.getExtensionStatuses().entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatus(text));
    if (statuses.length) {
        lines.push(truncateToWidth(statuses.join(' '), width, theme.fg('dim', '...')));
    }

    return lines;
}

function renderHeader(
    width: number,
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    elapsedMs: number
): string {
    const modelName = ctx.model?.id ?? 'no-model';
    const thinking = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
    const modelAndThinking = thinking
        ? `${modelName} ─ ${theme.getThinkingBorderColor(thinking)(
              thinking === 'off' ? 'thinking off' : thinking
          )}`
        : modelName;
    const elapsed = formatElapsed(elapsedMs);
    const elapsedAndModel = `${elapsed} ─ ${modelAndThinking}`;
    let modelDisplay =
        footerData.getAvailableProviderCount() > 1 && ctx.model
            ? `${elapsed} ─ (${ctx.model.provider}) ${modelAndThinking}`
            : elapsedAndModel;

    const cwd = formatCwd(ctx.sessionManager.getCwd());
    let cwdDisplay = theme.fg('dim', cwd);
    const branch = footerData.getGitBranch();
    if (branch) {
        cwdDisplay += theme.fg('dim', ' [') + theme.fg('text', branch) + theme.fg('dim', ']');
    }
    const sessionName = ctx.sessionManager.getSessionName();
    if (sessionName) cwdDisplay += theme.fg('dim', ` ─ ${sessionName}`);

    if (visibleWidth(cwdDisplay) + 2 + visibleWidth(modelDisplay) > width && ctx.model) {
        modelDisplay = elapsedAndModel;
    }

    return alignContent(cwdDisplay, modelDisplay, width, theme);
}

function renderStats(
    width: number,
    theme: Theme,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    usageLimit: UsageLimit
): string {
    const usage = getFooterContextUsage(ctx, pi);
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const contextTokens = usage?.tokens;
    const contextPercent = usage?.percent;
    const estimateMarker = usage?.isStartupEstimate ? '~' : '';
    const contextText =
        contextTokens === null || contextTokens === undefined
            ? `?/${formatTokens(contextWindow)}•?%`
            : `${estimateMarker}${formatTokens(contextTokens)}/${formatTokens(contextWindow)} (${estimateMarker}${formatPercent(contextPercent)}%)`;
    const themedContext =
        contextPercent !== null && contextPercent !== undefined && contextPercent > 90
            ? theme.fg('error', contextText)
            : contextPercent !== null && contextPercent !== undefined && contextPercent > 70
              ? theme.fg('warning', contextText)
              : theme.fg('dim', contextText);

    const usageWidth = Math.max(0, width - visibleWidth(themedContext) - 2);
    const usageDisplay = theme.fg('dim', formatUsageLimit(usageLimit, usageWidth));
    return alignContent(usageDisplay, themedContext, width, theme);
}

function formatUsageLimit(usage: UsageLimit, availableWidth: number): string {
    if (usage.kind === 'message') return usage.text;

    const filled = Math.round((usage.remainingPercent / 100) * USAGE_BAR_WIDTH);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(USAGE_BAR_WIDTH - filled)}`;
    const base = `${usage.label} ${bar} ${Math.round(usage.remainingPercent)}%`;
    if (!usage.resetAt) return base;

    const reset = formatResetDuration(usage.resetAt);
    const variants = [`${base} · resets in ${reset.full}`, `${base} ↻${reset.compact}`, base];
    return variants.find((variant) => visibleWidth(variant) <= availableWidth) ?? base;
}

function formatResetDuration(resetAt: number): { full: string; compact: string } {
    const remainingMinutes = Math.max(0, Math.ceil((resetAt * 1000 - Date.now()) / 60_000));
    if (remainingMinutes === 0) return { full: 'now', compact: 'now' };
    if (remainingMinutes < 60) {
        const value = `${remainingMinutes}m`;
        return { full: value, compact: value };
    }

    const hours = Math.floor(remainingMinutes / 60);
    if (hours < 24) {
        const minutes = remainingMinutes % 60;
        return {
            full: minutes ? `${hours}h ${minutes}m` : `${hours}h`,
            compact: `${hours}h`,
        };
    }

    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return {
        full: remainingHours ? `${days}d ${remainingHours}h` : `${days}d`,
        compact: `${days}d`,
    };
}

function alignContent(left: string, right: string, width: number, theme: Theme): string {
    if (visibleWidth(left) > width) {
        left = truncateToWidth(left, width, theme.fg('dim', '...'));
    }

    const leftWidth = visibleWidth(left);
    const availableRight = width - leftWidth - 2;
    right = availableRight > 0 ? truncateToWidth(right, availableRight, '') : '';
    const padding = ' '.repeat(Math.max(0, width - leftWidth - visibleWidth(right)));
    return left + theme.fg('dim', padding + right);
}

function frameLine(content: string, width: number, theme: Theme, top: boolean): string {
    if (width < 6) return truncateToWidth(content, width, '');

    const contentWidth = width - 6;
    const fill = '─'.repeat(Math.max(0, contentWidth - visibleWidth(content)));
    const leftBorder = top ? '╭─ ' : '╰─ ';
    const rightBorder = top ? ' ─╮' : ' ─╯';
    return theme.fg('dim', leftBorder) + content + theme.fg('dim', fill + rightBorder);
}

function formatElapsed(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const totalHours = Math.floor(totalMinutes / 60);
    const hours = totalHours % 24;
    const days = Math.floor(totalHours / 24);

    if (days) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
    if (totalHours) return `${totalHours}h ${minutes}m ${seconds}s`;
    if (totalMinutes) return `${totalMinutes}m ${seconds}s`;
    return `${seconds}s`;
}

function formatTokens(count: number): string {
    if (count < 1_000) return String(count);
    if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
    if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
    if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    return `${Math.round(count / 1_000_000)}M`;
}

function formatPercent(percent: number | null | undefined): string {
    return percent === null || percent === undefined ? '?' : Math.round(percent).toString();
}

function formatCwd(cwd: string): string {
    const home = homedir();
    const resolvedCwd = resolve(cwd);
    const relativeToHome = relative(resolve(home), resolvedCwd);
    const isInsideHome =
        relativeToHome === '' ||
        (relativeToHome !== '..' &&
            !relativeToHome.startsWith(`..${sep}`) &&
            !isAbsolute(relativeToHome));

    if (!isInsideHome) return cwd;
    return relativeToHome === '' ? '~' : `~${sep}${relativeToHome}`;
}

function sanitizeStatus(text: string): string {
    return text
        .replace(/[\r\n\t]/g, ' ')
        .replace(/ +/g, ' ')
        .trim();
}
