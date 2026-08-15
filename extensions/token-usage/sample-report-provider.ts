import type { TokenReportProvider } from './provider.ts';
import type { TokenReport, TokenUsageSummary } from './types.ts';

export type SampleTokenReportVariant = 'default' | 'zero' | 'formatting-edge' | 'layout-edge';

const usage = (
    processed: number,
    knownCostUsd: number,
    unknownCostEvents: number,
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    subagentShare: number | null
): TokenUsageSummary => ({
    processed,
    knownCostUsd,
    unknownCostEvents,
    input,
    output,
    cacheRead,
    cacheWrite,
    subagentShare,
});

const DEFAULT_REPORT: TokenReport = {
    source: { kind: 'sample', label: 'built-in development sample' },
    periods: {
        lifetime: usage(12_845_900, 18.42, 1, 4_205_000, 1_140_900, 7_250_000, 250_000, 0.28),
        today: usage(84_320, 0.12, 0, 31_000, 8_320, 43_000, 2_000, 0.31),
        sevenDays: usage(1_285_400, 2.07, 0, 421_000, 104_400, 730_000, 30_000, 0.24),
        thirtyDays: usage(4_921_700, 7.83, 0, 1_560_000, 401_700, 2_840_000, 120_000, 0.19),
    },
    disclaimer: 'Sample values only; no session data was read.',
};

const ZERO_REPORT: TokenReport = {
    source: { kind: 'sample', label: 'built-in zero-usage sample' },
    periods: {
        lifetime: usage(0, 0, 0, 0, 0, 0, 0, null),
        today: usage(0, 0, 0, 0, 0, 0, 0, null),
        sevenDays: usage(0, 0, 0, 0, 0, 0, 0, null),
        thirtyDays: usage(0, 0, 0, 0, 0, 0, 0, null),
    },
    disclaimer: 'Sample values only; no session data was read.',
};

const FORMATTING_EDGE_REPORT: TokenReport = {
    source: { kind: 'sample', label: 'formatting edge-value sample' },
    periods: {
        lifetime: usage(
            8_765_432_109_876_543,
            0.0000004,
            8_765_432_109_876,
            4_000_000_000_000_000,
            765_432_109_876_543,
            3_500_000_000_000_000,
            500_000_000_000_000,
            0.0006
        ),
        today: usage(999, 0.000001, 1, 1, 2, 3, 4, null),
        sevenDays: usage(999_999, 0.009999, 999_999, 999, 1_000, 1_000_000, 1_000_000_000, 0.1234),
        thirtyDays: usage(
            9_007_199_254_740_991,
            9_999_999.99,
            9_007_199_254_740_991,
            2_000_000_000_000_000,
            2_007_199_254_740_991,
            2_500_000_000_000_000,
            2_500_000_000_000_000,
            0.9994
        ),
    },
    disclaimer: 'Sample values only; no session data was read.',
};

const LAYOUT_EDGE_REPORT: TokenReport = {
    ...DEFAULT_REPORT,
    source: {
        kind: 'sample',
        label: 'an intentionally very long built-in development sample label that must be truncated safely',
    },
    disclaimer:
        'This intentionally long sample disclaimer verifies that prose wraps safely, remains compact, and is truncated when more than two lines would otherwise be needed; no session data was read.',
};

const REPORTS: Record<SampleTokenReportVariant, TokenReport> = {
    default: DEFAULT_REPORT,
    zero: ZERO_REPORT,
    'formatting-edge': FORMATTING_EDGE_REPORT,
    'layout-edge': LAYOUT_EDGE_REPORT,
};

function cloneReport(report: TokenReport): TokenReport {
    return {
        source: { ...report.source },
        periods: {
            lifetime: { ...report.periods.lifetime },
            today: { ...report.periods.today },
            sevenDays: { ...report.periods.sevenDays },
            thirtyDays: { ...report.periods.thirtyDays },
        },
        disclaimer: report.disclaimer,
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
