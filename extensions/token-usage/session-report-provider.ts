import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { aggregateUsageEvents } from './accounting.ts';
import type { TokenReportProvider } from './provider.ts';
import { discoverSessionFiles } from './session-discovery.ts';
import { scanSessionFiles } from './session-parser.ts';
import { mergeCurrentSessionSnapshot, reconcileUsageEvents } from './subagent-reconciliation.ts';

export interface SessionReportProviderOptions {
    /** Override only for deterministic tests; production uses Pi's agent directory. */
    defaultSessionRoot?: string;
    parseConcurrency?: number;
}

/** Construct a fresh, read-only report from discovered sessions and the active snapshot. */
export function createSessionReportProvider(
    options: SessionReportProviderOptions = {}
): TokenReportProvider {
    const defaultSessionRoot = options.defaultSessionRoot ?? join(getAgentDir(), 'sessions');

    return {
        async load(request) {
            const { signal } = request;
            signal.throwIfAborted();

            const files = await discoverSessionFiles(
                [defaultSessionRoot, request.currentSession.directory],
                { signal }
            );
            signal.throwIfAborted();

            const diskSessions = await scanSessionFiles(files, {
                signal,
                concurrency: options.parseConcurrency,
            });
            signal.throwIfAborted();

            const sessions = await mergeCurrentSessionSnapshot(
                diskSessions,
                request.currentSession,
                { signal }
            );
            signal.throwIfAborted();

            const events = await reconcileUsageEvents(sessions, { signal });
            signal.throwIfAborted();

            return aggregateUsageEvents(events, request.now, { signal });
        },
    };
}
