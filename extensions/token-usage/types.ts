export interface TokenReport {
    source: {
        kind: 'sample' | 'session-records';
        label: string;
    };
    periods: {
        lifetime: TokenUsageSummary;
        today: TokenUsageSummary;
        sevenDays: TokenUsageSummary;
        thirtyDays: TokenUsageSummary;
    };
    disclaimer: string;
}

export interface TokenComponents {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface TokenUsageSummary extends TokenComponents {
    processed: number;
    knownCostUsd: number;
    unknownCostEvents: number;
    subagentShare: number | null;
}
