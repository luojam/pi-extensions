import type { TokenReportProvider } from './provider.ts';
import type { TokenReport, TokenUsageSummary } from './types.ts';

export type SampleTokenReportVariant = 'default' | 'zero' | 'formatting-edge';

const usage = (
    recordedCostUsd: number,
    subagentProcessed: number,
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number
): TokenUsageSummary => ({
    recordedCostUsd,
    subagentProcessed,
    input,
    output,
    cacheRead,
    cacheWrite,
});

const DEFAULT_REPORT: TokenReport = {
    periods: {
        lifetime: usage(18.42, 3_596_852, 4_205_000, 1_140_900, 7_250_000, 250_000),
        today: usage(0.12, 26_139, 31_000, 8_320, 43_000, 2_000),
        sevenDays: usage(2.07, 308_496, 421_000, 104_400, 730_000, 30_000),
        thirtyDays: usage(7.83, 935_123, 1_560_000, 401_700, 2_840_000, 120_000),
    },
};

const ZERO_REPORT: TokenReport = {
    periods: {
        lifetime: usage(0, 0, 0, 0, 0, 0),
        today: usage(0, 0, 0, 0, 0, 0),
        sevenDays: usage(0, 0, 0, 0, 0, 0),
        thirtyDays: usage(0, 0, 0, 0, 0, 0),
    },
};

const FORMATTING_EDGE_REPORT: TokenReport = {
    periods: {
        lifetime: usage(
            0.0000004,
            5_259_259_265_925,
            4_000_000_000_000_000,
            765_432_109_876_543,
            3_500_000_000_000_000,
            500_000_000_000_000
        ),
        today: usage(0.000001, 0, 1, 2, 3, 4),
        sevenDays: usage(0.009999, 123_523_647, 999, 1_000, 1_000_000, 1_000_000_000),
        thirtyDays: usage(
            9_999_999.99,
            9_007_199_254_740_990,
            2_000_000_000_000_000,
            2_007_199_254_740_991,
            2_500_000_000_000_000,
            2_500_000_000_000_000
        ),
    },
};

const REPORTS: Record<SampleTokenReportVariant, TokenReport> = {
    default: DEFAULT_REPORT,
    zero: ZERO_REPORT,
    'formatting-edge': FORMATTING_EDGE_REPORT,
};

function cloneReport(report: TokenReport): TokenReport {
    return {
        periods: {
            lifetime: { ...report.periods.lifetime },
            today: { ...report.periods.today },
            sevenDays: { ...report.periods.sevenDays },
            thirtyDays: { ...report.periods.thirtyDays },
        },
    };
}

export function createSampleTokenReportProvider(
    variant: SampleTokenReportVariant = 'default'
): TokenReportProvider {
    return {
        async load(): Promise<TokenReport> {
            return cloneReport(REPORTS[variant]);
        },
    };
}
