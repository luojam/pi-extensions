import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { ExtractedSession, ExtractedUsageEvent, SubagentReference } from './session-parser.ts';
import { canonicalizeSubagentReferences, extractSessionEntries } from './session-parser.ts';
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
    snapshot: CurrentSessionSnapshot
): Promise<ExtractedSession[]> {
    let sourceFile: string | undefined;
    if (snapshot.file !== undefined) {
        const requestedFile = isAbsolute(snapshot.file)
            ? snapshot.file
            : resolve(snapshot.directory, snapshot.file);
        try {
            sourceFile = await realpath(requestedFile);
        } catch {
            sourceFile = resolve(requestedFile);
        }
    }

    const current = extractSessionEntries(snapshot.entries, {
        sourceFile,
        sourceKey: sourceFile === undefined ? `memory:${snapshot.id}` : `file:${sourceFile}`,
        sessionId: snapshot.id,
        version: 3,
        isSubagentFile: sourceFile !== undefined && isSubagentPath(sourceFile),
        linkBaseDirectory: snapshot.directory,
    });
    await canonicalizeSubagentReferences(current);
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

function logicalSessions(sessions: readonly ExtractedSession[]): Map<string, LogicalSession> {
    const logical = new Map<string, LogicalSession>();
    for (const session of sessions) {
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
        merged.events.push(...session.events);
        merged.references.push(...session.references);
    }
    return logical;
}

function uniqueSessionIdIndex(sessions: Map<string, LogicalSession>): Map<string, string> {
    const candidates = new Map<string, Set<string>>();
    for (const session of sessions.values()) {
        for (const id of session.sessionIds) {
            const sources = candidates.get(id) ?? new Set<string>();
            sources.add(session.sourceKey);
            candidates.set(id, sources);
        }
    }

    const unique = new Map<string, string>();
    for (const [id, sources] of candidates) {
        if (sources.size === 1) unique.set(id, [...sources][0]);
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
export function reconcileUsageEvents(sessions: readonly ExtractedSession[]): UsageEvent[] {
    const logical = logicalSessions(sessions);
    const byFile = new Map<string, string>();
    for (const session of logical.values()) {
        if (session.sourceFile !== undefined) {
            byFile.set(resolve(session.sourceFile), session.sourceKey);
        }
    }
    const bySessionId = uniqueSessionIdIndex(logical);
    const children = new Map<string, Set<string>>();
    const authoritativeRoots = new Set<string>();
    const referencedChildren = new Set<string>();

    for (const session of logical.values()) {
        for (const reference of session.references) {
            const child = resolveReference(reference, byFile, bySessionId);
            if (child === undefined || child === session.sourceKey) continue;
            const descendants = children.get(session.sourceKey) ?? new Set<string>();
            descendants.add(child);
            children.set(session.sourceKey, descendants);
            referencedChildren.add(child);
            if (reference.authoritative) authoritativeRoots.add(child);
        }
    }

    const suppressed = new Set<string>();
    const pending = [...authoritativeRoots];
    while (pending.length > 0) {
        const sourceKey = pending.pop();
        if (sourceKey === undefined || suppressed.has(sourceKey)) continue;
        suppressed.add(sourceKey);
        for (const child of children.get(sourceKey) ?? []) pending.push(child);
    }

    // A fork can contain a physical copy of a suppressed child transcript under another
    // source key. Suppress only its copied prefix: work added after the fork has new
    // fingerprints and remains countable.
    const suppressedFingerprints = new Set<string>();
    for (const sourceKey of suppressed) {
        for (const event of logical.get(sourceKey)?.events ?? []) {
            suppressedFingerprints.add(event.fingerprint);
        }
    }
    const surviving: ExtractedUsageEvent[] = [];
    for (const session of logical.values()) {
        if (suppressed.has(session.sourceKey)) continue;
        const classifyAsSubagent =
            session.isSubagentFile || referencedChildren.has(session.sourceKey);
        for (const event of session.events) {
            if (suppressedFingerprints.has(event.fingerprint)) continue;
            surviving.push(
                classifyAsSubagent && event.origin !== 'subagent'
                    ? { ...event, origin: 'subagent' }
                    : event
            );
        }
    }

    return deduplicateUsageEvents(surviving);
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
