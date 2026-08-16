import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import {
    type CooperativeWorkOptions,
    createWorkCheckpoint,
    type WorkCheckpoint,
} from './cooperative-work.ts';
import type { ExtractedSession, ExtractedUsageEvent, SubagentReference } from './session-parser.ts';
import {
    canonicalizeSubagentReferences,
    extractSessionEntriesCooperatively,
} from './session-parser.ts';
import type { UsageEvent } from './types.ts';

export interface CurrentSessionSnapshot {
    id: string;
    file?: string;
    directory: string;
    entries: readonly unknown[];
}

function isSubagentPath(path: string): boolean {
    return path.split(sep).includes('subagents');
}

/** Add a manager snapshot as another physical view of the current session. */
export async function mergeCurrentSessionSnapshot(
    sessions: readonly ExtractedSession[],
    snapshot: CurrentSessionSnapshot,
    options: CooperativeWorkOptions = {}
): Promise<ExtractedSession[]> {
    options.signal?.throwIfAborted();
    let sourceFile: string | undefined;
    if (snapshot.file !== undefined) {
        const requestedFile = isAbsolute(snapshot.file)
            ? snapshot.file
            : resolve(snapshot.directory, snapshot.file);
        try {
            sourceFile = await realpath(requestedFile);
        } catch {
            options.signal?.throwIfAborted();
            sourceFile = resolve(requestedFile);
        }
    }

    const current = await extractSessionEntriesCooperatively(
        snapshot.entries,
        {
            sourceFile,
            sourceKey: sourceFile === undefined ? `memory:${snapshot.id}` : `file:${sourceFile}`,
            sessionId: snapshot.id,
            version: 3,
            isSubagentFile: sourceFile !== undefined && isSubagentPath(sourceFile),
            linkBaseDirectory: snapshot.directory,
        },
        options
    );
    await canonicalizeSubagentReferences(current, options.signal);
    options.signal?.throwIfAborted();
    return [...sessions, current];
}

interface LogicalSession {
    sourceKey: string;
    sourceFile?: string;
    sessionIds: Set<string>;
    isSubagentFile: boolean;
    events: ExtractedUsageEvent[];
    references: SubagentReference[];
}

async function logicalSessions(
    sessions: readonly ExtractedSession[],
    checkpoint: WorkCheckpoint
): Promise<Map<string, LogicalSession>> {
    const logical = new Map<string, LogicalSession>();
    for (const session of sessions) {
        const sessionPause = checkpoint();
        if (sessionPause !== undefined) await sessionPause;

        let merged = logical.get(session.sourceKey);
        if (merged === undefined) {
            merged = {
                sourceKey: session.sourceKey,
                sourceFile: session.sourceFile,
                sessionIds: new Set(),
                isSubagentFile: session.isSubagentFile,
                events: [],
                references: [],
            };
            logical.set(session.sourceKey, merged);
        }
        if (session.sessionId !== undefined) merged.sessionIds.add(session.sessionId);
        merged.isSubagentFile ||= session.isSubagentFile;
        for (const event of session.events) {
            merged.events.push(event);
            const pause = checkpoint();
            if (pause !== undefined) await pause;
        }
        for (const reference of session.references) {
            merged.references.push(reference);
            const pause = checkpoint();
            if (pause !== undefined) await pause;
        }
    }
    return logical;
}

async function uniqueSessionIdIndex(
    sessions: Map<string, LogicalSession>,
    checkpoint: WorkCheckpoint
): Promise<Map<string, string>> {
    const candidates = new Map<string, Set<string>>();
    for (const session of sessions.values()) {
        for (const id of session.sessionIds) {
            const sources = candidates.get(id) ?? new Set<string>();
            sources.add(session.sourceKey);
            candidates.set(id, sources);
            const pause = checkpoint();
            if (pause !== undefined) await pause;
        }
    }

    const unique = new Map<string, string>();
    for (const [id, sources] of candidates) {
        if (sources.size === 1) {
            const source = sources.values().next().value;
            if (source !== undefined) unique.set(id, source);
        }
        const pause = checkpoint();
        if (pause !== undefined) await pause;
    }
    return unique;
}

function resolveReference(
    reference: SubagentReference,
    byFile: Map<string, string>,
    bySessionId: Map<string, string>
): string | undefined {
    const pathMatch =
        reference.childFile === undefined ? undefined : byFile.get(resolve(reference.childFile));
    const idMatch =
        reference.childSessionId === undefined
            ? undefined
            : bySessionId.get(reference.childSessionId);

    if (pathMatch !== undefined && idMatch !== undefined && pathMatch !== idMatch) return undefined;
    return pathMatch ?? idMatch;
}

/**
 * Suppress physical child transcripts covered by authoritative parent rollups, classify
 * fallback/unreferenced child work, then deduplicate forked and cloned accounting events.
 */
export async function reconcileUsageEvents(
    sessions: readonly ExtractedSession[],
    options: CooperativeWorkOptions = {}
): Promise<UsageEvent[]> {
    const checkpoint = createWorkCheckpoint(options);
    const logical = await logicalSessions(sessions, checkpoint);
    const byFile = new Map<string, string>();
    for (const session of logical.values()) {
        if (session.sourceFile !== undefined) {
            byFile.set(resolve(session.sourceFile), session.sourceKey);
        }
        const pause = checkpoint();
        if (pause !== undefined) await pause;
    }
    const bySessionId = await uniqueSessionIdIndex(logical, checkpoint);
    const children = new Map<string, Set<string>>();
    const authoritativeRoots = new Set<string>();
    const referencedChildren = new Set<string>();

    for (const session of logical.values()) {
        for (const reference of session.references) {
            const child = resolveReference(reference, byFile, bySessionId);
            if (child !== undefined && child !== session.sourceKey) {
                const descendants = children.get(session.sourceKey) ?? new Set<string>();
                descendants.add(child);
                children.set(session.sourceKey, descendants);
                referencedChildren.add(child);
                if (reference.authoritative) authoritativeRoots.add(child);
            }
            const pause = checkpoint();
            if (pause !== undefined) await pause;
        }
    }

    const suppressed = new Set<string>();
    const pending: string[] = [];
    for (const sourceKey of authoritativeRoots) {
        pending.push(sourceKey);
        const pause = checkpoint();
        if (pause !== undefined) await pause;
    }
    while (pending.length > 0) {
        const sourceKey = pending.pop();
        if (sourceKey !== undefined && !suppressed.has(sourceKey)) {
            suppressed.add(sourceKey);
            for (const child of children.get(sourceKey) ?? []) {
                pending.push(child);
                const childPause = checkpoint();
                if (childPause !== undefined) await childPause;
            }
        }
        const pause = checkpoint();
        if (pause !== undefined) await pause;
    }

    // A fork can contain a physical copy of a suppressed child transcript under another
    // source key. Suppress only its copied prefix: work added after the fork has new
    // fingerprints and remains countable.
    const suppressedFingerprints = new Set<string>();
    for (const sourceKey of suppressed) {
        for (const event of logical.get(sourceKey)?.events ?? []) {
            suppressedFingerprints.add(event.fingerprint);
            const pause = checkpoint();
            if (pause !== undefined) await pause;
        }
    }
    const surviving: ExtractedUsageEvent[] = [];
    for (const session of logical.values()) {
        if (!suppressed.has(session.sourceKey)) {
            const classifyAsSubagent =
                session.isSubagentFile || referencedChildren.has(session.sourceKey);
            for (const event of session.events) {
                if (!suppressedFingerprints.has(event.fingerprint)) {
                    surviving.push(
                        classifyAsSubagent && event.origin !== 'subagent'
                            ? { ...event, origin: 'subagent' }
                            : event
                    );
                }
                const pause = checkpoint();
                if (pause !== undefined) await pause;
            }
        }
        const pause = checkpoint();
        if (pause !== undefined) await pause;
    }

    const events = await deduplicateUsageEventsCooperatively(surviving, checkpoint);
    options.signal?.throwIfAborted();
    return events;
}

async function deduplicateUsageEventsCooperatively(
    events: readonly UsageEvent[],
    checkpoint: WorkCheckpoint
): Promise<UsageEvent[]> {
    const byFingerprint = new Map<string, UsageEvent>();
    for (const event of events) {
        const existing = byFingerprint.get(event.fingerprint);
        if (existing === undefined) {
            byFingerprint.set(event.fingerprint, event);
        } else if (existing.origin !== 'subagent' && event.origin === 'subagent') {
            byFingerprint.set(event.fingerprint, event);
        }
        const pause = checkpoint();
        if (pause !== undefined) await pause;
    }

    const result: UsageEvent[] = [];
    for (const event of byFingerprint.values()) {
        result.push(event);
        const pause = checkpoint();
        if (pause !== undefined) await pause;
    }
    return result;
}

/** Deduplicate accounting identities, preferring subagent classification when copies differ. */
export function deduplicateUsageEvents(events: readonly UsageEvent[]): UsageEvent[] {
    const byFingerprint = new Map<string, UsageEvent>();
    for (const event of events) {
        const existing = byFingerprint.get(event.fingerprint);
        if (existing === undefined) {
            byFingerprint.set(event.fingerprint, event);
        } else if (existing.origin !== 'subagent' && event.origin === 'subagent') {
            byFingerprint.set(event.fingerprint, event);
        }
    }
    return [...byFingerprint.values()];
}
