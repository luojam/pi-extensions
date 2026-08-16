import type { TokenComponents, TokenReport, TokenUsageSummary, UsageEvent } from './types.ts';

const ZERO_SUMMARY = (): TokenUsageSummary => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    recordedCostUsd: 0,
    subagentProcessed: 0,
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0;
}

/** Read token components only when every required component is valid. */
export function tokenComponentsFromUsage(usage: unknown): TokenComponents | null {
    if (!isRecord(usage)) return null;

    const { input, output, cacheRead, cacheWrite } = usage;
    if (
        !isNonNegativeFiniteNumber(input) ||
        !isNonNegativeFiniteNumber(output) ||
        !isNonNegativeFiniteNumber(cacheRead) ||
        !isNonNegativeFiniteNumber(cacheWrite)
    ) {
        return null;
    }

    return { input, output, cacheRead, cacheWrite };
}

/** Read usage.cost.total independently of token-component validity. */
export function recordedCostUsdFromUsage(usage: unknown): number | undefined {
    if (!isRecord(usage) || !isRecord(usage.cost)) return undefined;
    return isNonNegativeFiniteNumber(usage.cost.total) ? usage.cost.total : undefined;
}

/** The canonical processed-token total for a report summary. */
export function processedTokens(summary: TokenComponents): number {
    return summary.input + summary.output + summary.cacheRead + summary.cacheWrite;
}

/** The observed subagent token share, or null when no processed tokens were observed. */
export function subagentShare(summary: TokenUsageSummary): number | null {
    const processed = processedTokens(summary);
    return processed === 0 ? null : summary.subagentProcessed / processed;
}

function addEvent(
    summary: TokenUsageSummary,
    event: UsageEvent,
    components: TokenComponents
): void {
    summary.input += components.input;
    summary.output += components.output;
    summary.cacheRead += components.cacheRead;
    summary.cacheWrite += components.cacheWrite;

    if (isNonNegativeFiniteNumber(event.recordedCostUsd)) {
        summary.recordedCostUsd += event.recordedCostUsd;
    }
    if (event.origin === 'subagent') {
        summary.subagentProcessed += processedTokens(components);
    }
}

function localMidnightDaysAgo(now: Date, daysAgo: number): number {
    const boundary = new Date(now.getTime());
    boundary.setHours(0, 0, 0, 0);
    boundary.setDate(boundary.getDate() - daysAgo);
    return boundary.getTime();
}

/** Aggregate accepted events using local-calendar windows and one injected cutoff. */
export function aggregateUsageEvents(events: readonly UsageEvent[], now: Date): TokenReport {
    const periods: TokenReport['periods'] = {
        today: ZERO_SUMMARY(),
        sevenDays: ZERO_SUMMARY(),
        thirtyDays: ZERO_SUMMARY(),
        lifetime: ZERO_SUMMARY(),
    };
    const cutoff = now.getTime();
    const todayStart = localMidnightDaysAgo(now, 0);
    const sevenDaysStart = localMidnightDaysAgo(now, 6);
    const thirtyDaysStart = localMidnightDaysAgo(now, 29);

    for (const event of events) {
        const components = tokenComponentsFromUsage(event.components);
        if (components === null) continue;

        addEvent(periods.lifetime, event, components);

        const occurredAt = event.occurredAt;
        if (!isFiniteNumber(occurredAt) || !Number.isFinite(cutoff) || occurredAt > cutoff) {
            continue;
        }

        if (occurredAt >= thirtyDaysStart) addEvent(periods.thirtyDays, event, components);
        if (occurredAt >= sevenDaysStart) addEvent(periods.sevenDays, event, components);
        if (occurredAt >= todayStart) addEvent(periods.today, event, components);
    }

    return { periods };
}
