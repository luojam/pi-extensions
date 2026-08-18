export interface TokenReport {
    periods: {
        lifetime: TokenUsageSummary;
        today: TokenUsageSummary;
        sevenDays: TokenUsageSummary;
        thirtyDays: TokenUsageSummary;
    };
}

export interface TokenComponents {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface TokenUsageSummary extends TokenComponents {
    recordedCostUsd: number;
    subagentProcessed: number;
}

export type UsageOrigin = 'assistant' | 'tool' | 'subagent' | 'compaction' | 'branch-summary';

/** Internal accounting record shared by extraction, reconciliation, and aggregation. */
export interface UsageEvent {
    fingerprint: string;
    occurredAt?: number;
    components: TokenComponents;
    recordedCostUsd?: number;
    origin: UsageOrigin;
    sourceFile?: string;
}
