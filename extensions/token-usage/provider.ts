import { createSampleTokenReportProvider } from './sample-report-provider.ts';
import type { TokenReport } from './types.ts';

export interface TokenReportProvider {
    load(): Promise<TokenReport>;
}

/** The construction seam for the future session-record provider. */
export function createTokenReportProvider(): TokenReportProvider {
    return createSampleTokenReportProvider();
}
