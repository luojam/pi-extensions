import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * A mostly stock pi footer with expanded context usage:
 *
 *     53k/272k•19.5%
 *
 * The token count is shown first instead of displaying only a percentage.
 */
export default function contextFooter(pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;

        ctx.ui.setFooter((tui, theme, footerData) => {
            const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

            return {
                dispose: unsubscribe,
                invalidate() {},
                render(width: number): string[] {
                    // Reserve room for "╭─ " / " ─╮" while keeping the footer at two rows.
                    const contentWidth = Math.max(0, width - 6);
                    const frameLine = (content: string, top: boolean): string => {
                        if (width < 6) return truncateToWidth(content, width, "");

                        const fill = "─".repeat(Math.max(0, contentWidth - visibleWidth(content)));
                        const leftBorder = top ? "╭─ " : "╰─ ";
                        const rightBorder = top ? " ─╮" : " ─╯";
                        return theme.fg("dim", leftBorder) + content + theme.fg("dim", fill + rightBorder);
                    };

                    let input = 0;
                    let output = 0;
                    let cacheRead = 0;
                    let cacheWrite = 0;
                    let cost = 0;
                    let latestCacheHitRate: number | undefined;

                    for (const entry of ctx.sessionManager.getEntries()) {
                        if (entry.type !== "message" || entry.message.role !== "assistant") continue;

                        const message = entry.message as AssistantMessage;
                        input += message.usage.input;
                        output += message.usage.output;
                        cacheRead += message.usage.cacheRead;
                        cacheWrite += message.usage.cacheWrite;
                        cost += message.usage.cost.total;

                        const promptTokens =
                            message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
                        latestCacheHitRate = promptTokens > 0
                            ? (message.usage.cacheRead / promptTokens) * 100
                            : undefined;
                    }

                    const usage = ctx.getContextUsage();
                    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
                    const contextTokens = usage?.tokens;
                    const contextPercent = usage?.percent;

                    const plainParts: string[] = [];
                    if (input) plainParts.push(`↑${formatTokens(input)}`);
                    if (output) plainParts.push(`↓${formatTokens(output)}`);
                    if (cacheRead) plainParts.push(`R${formatTokens(cacheRead)}`);
                    if (cacheWrite) plainParts.push(`W${formatTokens(cacheWrite)}`);
                    if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) {
                        plainParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
                    }
                    if (cost) plainParts.push(`$${cost.toFixed(3)}`);

                    const contextText = contextTokens === null || contextTokens === undefined
                        ? `?/${formatTokens(contextWindow)}•?%`
                        : `${formatTokens(contextTokens)}/${formatTokens(contextWindow)}•${formatPercent(contextPercent)}%`;

                    const dimPrefix = plainParts.length
                        ? `${theme.fg("dim", plainParts.join(" "))} `
                        : "";
                    const themedContext = contextPercent !== null && contextPercent !== undefined && contextPercent > 90
                        ? theme.fg("error", contextText)
                        : contextPercent !== null && contextPercent !== undefined && contextPercent > 70
                            ? theme.fg("warning", contextText)
                            : theme.fg("dim", contextText);
                    let left = dimPrefix + themedContext;

                    const alignContent = (leftContent: string, rightContent: string): string => {
                        if (visibleWidth(leftContent) > contentWidth) {
                            leftContent = truncateToWidth(
                                leftContent,
                                contentWidth,
                                theme.fg("dim", "..."),
                            );
                        }

                        const leftWidth = visibleWidth(leftContent);
                        const availableRight = contentWidth - leftWidth - 2;
                        rightContent = availableRight > 0
                            ? truncateToWidth(rightContent, availableRight, "")
                            : "";
                        const padding = " ".repeat(
                            Math.max(0, contentWidth - leftWidth - visibleWidth(rightContent)),
                        );
                        return leftContent + theme.fg("dim", padding + rightContent);
                    };

                    const modelName = ctx.model?.id ?? "no-model";
                    const thinking = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
                    const modelAndThinking = thinking
                        ? `${modelName} • ${thinking === "off" ? "thinking off" : thinking}`
                        : modelName;
                    let modelDisplay = footerData.getAvailableProviderCount() > 1 && ctx.model
                        ? `(${ctx.model.provider}) ${modelAndThinking}`
                        : modelAndThinking;

                    let cwd = formatCwd(ctx.sessionManager.getCwd());
                    const branch = footerData.getGitBranch();
                    if (branch) cwd += ` (${branch})`;
                    const sessionName = ctx.sessionManager.getSessionName();
                    if (sessionName) cwd += ` • ${sessionName}`;

                    if (visibleWidth(cwd) + 2 + visibleWidth(modelDisplay) > contentWidth && ctx.model) {
                        modelDisplay = modelAndThinking;
                    }

                    const extensionStatuses = footerData.getExtensionStatuses();
                    const codexStatus = extensionStatuses.get("codex-usage");
                    const cleanCodexStatus = codexStatus ? sanitizeStatus(codexStatus) : undefined;
                    const extractedWeeklyUsage = cleanCodexStatus
                        ? extractWeeklyUsage(cleanCodexStatus)
                        : undefined;
                    const weeklyUsage = extractedWeeklyUsage ?? cleanCodexStatus ?? "";

                    const cwdLine = alignContent(
                        theme.fg("dim", cwd),
                        modelDisplay,
                    );
                    const statsLine = alignContent(left, weeklyUsage);
                    const lines = [
                        frameLine(cwdLine, true),
                        frameLine(statsLine, false),
                    ];

                    const statuses = [...extensionStatuses.entries()]
                        .sort(([a], [b]) => a.localeCompare(b))
                        .flatMap(([key, text]) => {
                            const status = sanitizeStatus(text);
                            if (key !== "codex-usage") return [status];
                            if (!extractedWeeklyUsage) return [];

                            const weekSeparator = status.indexOf(" · Week ");
                            return weekSeparator >= 0 ? [status.slice(0, weekSeparator)] : [];
                        });
                    if (statuses.length) {
                        lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
                    }

                    return lines;
                },
            };
        });
    });
}

function formatTokens(count: number): string {
    if (count < 1_000) return String(count);
    if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
    if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
    if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    return `${Math.round(count / 1_000_000)}M`;
}

function formatPercent(percent: number | null | undefined): string {
    return percent === null || percent === undefined ? "?" : percent.toFixed(1).replace(/\.0$/, "");
}

function formatCwd(cwd: string): string {
    const home = homedir();
    const resolvedCwd = resolve(cwd);
    const relativeToHome = relative(resolve(home), resolvedCwd);
    const isInsideHome = relativeToHome === ""
        || (relativeToHome !== ".."
            && !relativeToHome.startsWith(`..${sep}`)
            && !isAbsolute(relativeToHome));

    if (!isInsideHome) return cwd;
    return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatus(text: string): string {
    return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function extractWeeklyUsage(status: string): string | undefined {
    return status.match(/(?:^| · )(Week .*)$/)?.[1];
}
