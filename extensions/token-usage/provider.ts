import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { createSessionReportProvider } from './session-report-provider.ts';
import type { TokenReport } from './types.ts';

export interface TokenReportRequest {
    now: Date;
    signal: AbortSignal;
    currentSession: {
        id: string;
        file?: string;
        directory: string;
        entries: readonly SessionEntry[];
    };
}

export interface TokenReportProvider {
    load(request: TokenReportRequest): Promise<TokenReport>;
}

/** Production construction always uses the read-only session-record provider. */
export function createTokenReportProvider(): TokenReportProvider {
    return createSessionReportProvider();
}
