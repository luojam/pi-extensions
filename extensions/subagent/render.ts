import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { keyHint, type Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { truncateUtf8Head, truncateUtf8Tail } from './run-utils.ts';
import type { SubagentRunSnapshot, SubagentRunState, SubagentToolCallSnapshot } from './types.ts';

const TASK_MAX_BYTES = 512;
const FALLBACK_MAX_BYTES = 2 * 1024;
const EXPANDED_TEXT_MAX_BYTES = 8 * 1024;
const TASK_MAX_LINES = 8;
const TAIL_MAX_LINES = 16;

class WidthSafeLines implements Component {
    private readonly lines: () => string[];

    constructor(lines: () => string[]) {
        this.lines = lines;
    }

    render(width: number): string[] {
        if (width <= 0) return [];
        return this.lines().map((line) => truncateToWidth(line, width));
    }

    invalidate(): void {
        // Lines and theme styles are recomputed on every render.
    }
}

function singleLine(text: string): string {
    return text
        .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)?)/gu, '')
        .replace(/[\x00-\x1F\x7F-\x9F]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function boundedLine(text: string, maxBytes: number): string {
    return truncateUtf8Head(singleLine(text), maxBytes);
}

function safeMultiline(text: string): string {
    return text
        .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)?)/gu, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/gu, ' ');
}

function boundedMultilineLines(
    text: string,
    maxBytes: number,
    maxLines: number,
    fromTail = false
): string[] {
    const bounded = fromTail
        ? truncateUtf8Tail(safeMultiline(text), maxBytes)
        : truncateUtf8Head(safeMultiline(text), maxBytes);
    const allLines = bounded.split('\n');
    if (allLines.length <= maxLines) return allLines;
    return fromTail
        ? [`… ${allLines.length - maxLines} earlier lines omitted`, ...allLines.slice(-maxLines)]
        : [...allLines.slice(0, maxLines), `… ${allLines.length - maxLines} more lines omitted`];
}

function formatCost(cost: number): string {
    if (cost === 0) return '$0';
    if (cost < 0.0001) return '<$0.0001';
    return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
}

export function formatTokens(tokens: number): string {
    if (tokens < 1_000) return Math.round(tokens).toString();
    if (tokens < 1_000_000) {
        const value = tokens / 1_000;
        return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/u, '')}k`;
    }
    const value = tokens / 1_000_000;
    return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/u, '')}M`;
}

export function formatElapsed(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `${minutes}m${remainder ? ` ${remainder}s` : ''}`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function formatContext(snapshot: SubagentRunSnapshot): string | undefined {
    const usage = snapshot.contextUsage;
    if (!usage || usage.tokens === null) return undefined;
    const percent = usage.percent === null ? '' : ` (${Math.round(usage.percent)}%)`;
    return `context ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}${percent}`;
}

function stateLabel(state: SubagentRunState): string {
    switch (state) {
        case 'queued':
            return 'queued';
        case 'starting':
            return 'starting';
        case 'running':
            return 'running';
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
    }
}

function stateColor(state: SubagentRunState): 'muted' | 'warning' | 'accent' | 'success' | 'error' {
    switch (state) {
        case 'queued':
            return 'muted';
        case 'starting':
            return 'warning';
        case 'running':
            return 'accent';
        case 'completed':
            return 'success';
        case 'failed':
            return 'error';
        case 'cancelled':
            return 'warning';
    }
}

function toolSummary(snapshot: SubagentRunSnapshot): string | undefined {
    const tool = snapshot.currentTool ?? snapshot.recentToolCalls[0];
    if (!tool) return undefined;
    const input = tool.inputSummary ? ` ${tool.inputSummary}` : '';
    return `${tool.name}${input}`;
}

function snapshotStats(snapshot: SubagentRunSnapshot): string {
    return [
        formatContext(snapshot),
        snapshot.turn > 0 ? `turn ${snapshot.turn}` : undefined,
        formatElapsed(snapshot.elapsedMs),
    ]
        .filter((part): part is string => !!part)
        .join(' · ');
}

export function conciseSnapshotStatus(snapshot: SubagentRunSnapshot): string {
    const activity = toolSummary(snapshot);
    if (activity && (snapshot.state === 'running' || snapshot.state === 'completed')) {
        return `Subagent ${stateLabel(snapshot.state)}: ${activity}`;
    }
    return `Subagent ${stateLabel(snapshot.state)}`;
}

function isToolSnapshot(value: unknown): value is SubagentToolCallSnapshot {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<SubagentToolCallSnapshot>;
    return (
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.inputSummary === 'string' &&
        (candidate.progressSummary === undefined ||
            typeof candidate.progressSummary === 'string') &&
        (candidate.state === 'running' ||
            candidate.state === 'completed' ||
            candidate.state === 'failed') &&
        typeof candidate.startedAt === 'number'
    );
}

function hasValidOptionalStats(candidate: Partial<SubagentRunSnapshot>): boolean {
    const context = candidate.contextUsage;
    if (
        context !== undefined &&
        !(
            (typeof context.tokens === 'number' || context.tokens === null) &&
            typeof context.contextWindow === 'number' &&
            (typeof context.percent === 'number' || context.percent === null)
        )
    ) {
        return false;
    }

    const usage = candidate.usage;
    return (
        usage === undefined ||
        (typeof usage.input === 'number' &&
            typeof usage.output === 'number' &&
            typeof usage.cacheRead === 'number' &&
            typeof usage.cacheWrite === 'number' &&
            typeof usage.total === 'number' &&
            typeof usage.cost === 'number')
    );
}

export function isSubagentRunSnapshot(value: unknown): value is SubagentRunSnapshot {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<SubagentRunSnapshot>;
    return (
        typeof candidate.id === 'string' &&
        (candidate.state === 'queued' ||
            candidate.state === 'starting' ||
            candidate.state === 'running' ||
            candidate.state === 'completed' ||
            candidate.state === 'failed' ||
            candidate.state === 'cancelled') &&
        typeof candidate.task === 'string' &&
        typeof candidate.cwd === 'string' &&
        !!candidate.model &&
        typeof candidate.model.provider === 'string' &&
        typeof candidate.model.id === 'string' &&
        typeof candidate.thinkingLevel === 'string' &&
        typeof candidate.queuedAt === 'number' &&
        typeof candidate.elapsedMs === 'number' &&
        typeof candidate.turn === 'number' &&
        Array.isArray(candidate.recentToolCalls) &&
        candidate.recentToolCalls.every(isToolSnapshot) &&
        (candidate.currentTool === undefined || isToolSnapshot(candidate.currentTool)) &&
        typeof candidate.thinkingTail === 'string' &&
        typeof candidate.responseTail === 'string' &&
        (candidate.error === undefined || typeof candidate.error === 'string') &&
        hasValidOptionalStats(candidate)
    );
}

export function renderSubagentCall(args: { task: string }, theme: Theme): Component {
    return new WidthSafeLines(() => {
        const task = boundedLine(args.task, TASK_MAX_BYTES);
        return [
            theme.fg('toolTitle', theme.bold('Subagent')) +
                (task ? theme.fg('muted', ` · ${task}`) : ''),
        ];
    });
}

function activityLine(tool: SubagentToolCallSnapshot, current: boolean): string {
    const marker = current ? '→' : tool.state === 'completed' ? '✓' : '✗';
    const input = tool.inputSummary ? ` ${tool.inputSummary}` : '';
    const progress = current && tool.progressSummary ? ` · ${tool.progressSummary}` : '';
    return `${marker} ${tool.name}${input}${progress}`;
}

function usageLine(snapshot: SubagentRunSnapshot): string | undefined {
    if (!snapshot.usage) return undefined;
    const usage = snapshot.usage;
    return [
        `↑${formatTokens(usage.input)}`,
        `↓${formatTokens(usage.output)}`,
        `R${formatTokens(usage.cacheRead)}`,
        `W${formatTokens(usage.cacheWrite)}`,
        formatCost(usage.cost),
        formatElapsed(snapshot.elapsedMs),
    ].join(' · ');
}

function addSection(
    lines: string[],
    label: string,
    content: readonly string[],
    theme: Theme,
    color: 'toolOutput' | 'muted' | 'dim' | 'error' = 'toolOutput'
): void {
    if (content.length === 0) return;
    if (lines.length > 1) lines.push('');
    lines.push(`  ${theme.fg('accent', theme.bold(label))}`);
    for (const line of content) lines.push(`    ${theme.fg(color, line)}`);
}

function expandedSnapshotLines(
    snapshot: SubagentRunSnapshot,
    result: AgentToolResult<unknown>,
    theme: Theme
): string[] {
    const lines = [`  ${theme.fg(stateColor(snapshot.state), stateLabel(snapshot.state))}`];

    addSection(
        lines,
        'Task',
        boundedMultilineLines(snapshot.task, EXPANDED_TEXT_MAX_BYTES, TASK_MAX_LINES),
        theme
    );
    addSection(
        lines,
        'Runtime',
        [
            `cwd: ${boundedLine(snapshot.cwd, FALLBACK_MAX_BYTES)}`,
            `model: ${boundedLine(`${snapshot.model.provider}/${snapshot.model.id}`, FALLBACK_MAX_BYTES)} · thinking ${snapshot.thinkingLevel}`,
        ],
        theme,
        'muted'
    );

    const tools = [
        ...(snapshot.currentTool ? [activityLine(snapshot.currentTool, true)] : []),
        ...snapshot.recentToolCalls
            .filter((tool) => tool.id !== snapshot.currentTool?.id)
            .map((tool) => activityLine(tool, false)),
    ];
    addSection(lines, 'Activity', tools, theme, 'muted');

    if (snapshot.thinkingTail.trim()) {
        addSection(
            lines,
            'Thinking tail (provider-exposed)',
            boundedMultilineLines(
                snapshot.thinkingTail,
                EXPANDED_TEXT_MAX_BYTES,
                TAIL_MAX_LINES,
                true
            ),
            theme,
            'dim'
        );
    }

    const fallback = result.content.find((item) => item.type === 'text');
    const finalText = fallback?.type === 'text' ? fallback.text : '';
    const response = snapshot.responseTail || (snapshot.state === 'completed' ? finalText : '');
    if (response.trim()) {
        addSection(
            lines,
            snapshot.state === 'completed' ? 'Final output' : 'Response tail',
            boundedMultilineLines(response, EXPANDED_TEXT_MAX_BYTES, TAIL_MAX_LINES, true),
            theme
        );
    }

    const contextAndTurn = [
        formatContext(snapshot),
        snapshot.turn > 0 ? `turn ${snapshot.turn}` : undefined,
    ]
        .filter((part): part is string => !!part)
        .join(' · ');
    addSection(
        lines,
        'Stats',
        [
            contextAndTurn || undefined,
            usageLine(snapshot) ?? formatElapsed(snapshot.elapsedMs),
        ].filter((part): part is string => !!part),
        theme,
        'dim'
    );

    if ((snapshot.state === 'failed' || snapshot.state === 'cancelled') && snapshot.error) {
        addSection(
            lines,
            snapshot.state === 'failed' ? 'Failure' : 'Cancellation',
            boundedMultilineLines(snapshot.error, FALLBACK_MAX_BYTES, TASK_MAX_LINES),
            theme,
            'error'
        );
    }
    return lines;
}

export function renderSubagentResult(
    result: AgentToolResult<unknown>,
    expanded: boolean,
    theme: Theme
): Component {
    return new WidthSafeLines(() => {
        if (!isSubagentRunSnapshot(result.details)) {
            const fallback = result.content.find((item) => item.type === 'text');
            return [
                theme.fg(
                    'toolOutput',
                    truncateUtf8Head(
                        fallback?.type === 'text' ? singleLine(fallback.text) : '',
                        FALLBACK_MAX_BYTES
                    )
                ),
            ];
        }

        const snapshot = result.details;
        if (expanded) return expandedSnapshotLines(snapshot, result, theme);

        const label = stateLabel(snapshot.state);
        const activity = toolSummary(snapshot);
        const firstLine = [label, activity].filter(Boolean).join(' · ');
        const lines = [
            `  ${theme.fg(stateColor(snapshot.state), firstLine)}`,
            `  ${theme.fg('dim', snapshotStats(snapshot))} · ${keyHint('app.tools.expand', 'to expand')}`,
        ];
        if ((snapshot.state === 'failed' || snapshot.state === 'cancelled') && snapshot.error) {
            lines.push(`  ${theme.fg('error', boundedLine(snapshot.error, FALLBACK_MAX_BYTES))}`);
        }
        return lines;
    });
}

export function renderSubagentWidget(
    snapshot: SubagentRunSnapshot,
    queuedCount: number,
    theme: Theme
): Component {
    return new WidthSafeLines(() => {
        const activity = snapshot.currentTool?.name ?? stateLabel(snapshot.state);
        const queuedSuffix =
            queuedCount > (snapshot.state === 'queued' ? 1 : 0) ? ` · ${queuedCount} queued` : '';
        const line = [
            theme.fg('accent', 'subagent'),
            theme.fg(stateColor(snapshot.state), activity),
            formatContext(snapshot) ? theme.fg('muted', formatContext(snapshot)!) : undefined,
            theme.fg('dim', formatElapsed(snapshot.elapsedMs)),
        ]
            .filter((part): part is string => !!part)
            .join(theme.fg('dim', ' · '));
        return [line + theme.fg('dim', queuedSuffix)];
    });
}
