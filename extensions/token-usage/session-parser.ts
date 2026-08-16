import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { recordedCostUsdFromUsage, tokenComponentsFromUsage } from './accounting.ts';
import { type CooperativeWorkOptions, createWorkCheckpoint } from './cooperative-work.ts';
import type { DiscoveredSessionFile } from './session-discovery.ts';
import type { TokenComponents, UsageEvent, UsageOrigin } from './types.ts';

const MAX_SUPPORTED_SESSION_VERSION = 3;
const DEFAULT_PARSE_CONCURRENCY = 4;
const MAX_JSONL_LINE_BYTES = 64 * 1024 * 1024;

function isSubagentPath(path: string): boolean {
    return path.split(sep).includes('subagents');
}

export interface ExtractedUsageEvent extends UsageEvent {
    sourceKey: string;
}

export interface SubagentReference {
    childFile?: string;
    childSessionId?: string;
    authoritative: boolean;
}

export interface ExtractedSession {
    sourceKey: string;
    sourceFile?: string;
    sessionId?: string;
    version: number;
    isSubagentFile: boolean;
    events: ExtractedUsageEvent[];
    references: SubagentReference[];
}

export interface ExtractSessionEntriesOptions {
    sourceFile?: string;
    sourceKey?: string;
    sessionId?: string;
    version?: number;
    isSubagentFile?: boolean;
    /** Base for relative subagent links when there is no source file (ephemeral sessions). */
    linkBaseDirectory?: string;
}

interface FingerprintInput {
    carrier: 'assistant' | 'tool' | 'compaction' | 'branch-summary';
    role?: string;
    entryId?: string;
    ordinal?: number;
    occurredAt?: number;
    provider?: string;
    api?: string;
    model?: string;
    toolName?: string;
    toolCallId?: string;
    relatedId?: string;
    components: TokenComponents;
    recordedCostUsd?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizedNumber(value: number): number {
    return Object.is(value, -0) ? 0 : value;
}

function timestampFrom(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}

function messageTimestamp(
    message: Record<string, unknown>,
    entry: Record<string, unknown>
): number | undefined {
    return timestampFrom(message.timestamp) ?? timestampFrom(entry.timestamp);
}

/** Create a versioned, privacy-safe accounting identity without transcript content or paths. */
export function accountingFingerprint(input: FingerprintInput): string {
    const components = input.components;
    const stableTuple = [
        'token-usage-accounting-v1',
        input.carrier,
        input.role ?? null,
        input.entryId ?? null,
        // Clone creation can re-chain entries after filtering labels. An entry ID remains stable,
        // while parentId does not, so ordinal is needed only for legacy entries without an ID.
        input.entryId === undefined ? (input.ordinal ?? null) : null,
        input.occurredAt ?? null,
        input.provider ?? null,
        input.api ?? null,
        input.model ?? null,
        input.toolName ?? null,
        input.toolCallId ?? null,
        input.relatedId ?? null,
        normalizedNumber(components.input),
        normalizedNumber(components.output),
        normalizedNumber(components.cacheRead),
        normalizedNumber(components.cacheWrite),
        input.recordedCostUsd === undefined ? null : normalizedNumber(input.recordedCostUsd),
    ];
    return createHash('sha256').update(JSON.stringify(stableTuple)).digest('hex');
}

function normalizedEvent(
    usage: unknown,
    metadata: Omit<FingerprintInput, 'components' | 'recordedCostUsd'>,
    origin: UsageOrigin,
    sourceKey: string,
    sourceFile: string | undefined
): ExtractedUsageEvent | undefined {
    const components = tokenComponentsFromUsage(usage);
    if (components === null) return undefined;
    const recordedCostUsd = recordedCostUsdFromUsage(usage);
    const fingerprint = accountingFingerprint({ ...metadata, components, recordedCostUsd });
    return {
        fingerprint,
        occurredAt: metadata.occurredAt,
        components,
        recordedCostUsd,
        origin,
        sourceFile,
        sourceKey,
    };
}

function childReference(
    message: Record<string, unknown>,
    sourceFile: string | undefined,
    linkBaseDirectory: string | undefined,
    authoritative: boolean
): SubagentReference | undefined {
    if (message.toolName !== 'subagent' || !isRecord(message.details)) return undefined;
    const linkedFile = stringValue(message.details.sessionFile);
    const childSessionId = stringValue(message.details.sessionId);
    if (linkedFile === undefined && childSessionId === undefined) return undefined;

    let childFile: string | undefined;
    if (linkedFile !== undefined) {
        childFile = isAbsolute(linkedFile)
            ? resolve(linkedFile)
            : resolve(
                  sourceFile === undefined
                      ? (linkBaseDirectory ?? process.cwd())
                      : dirname(sourceFile),
                  linkedFile
              );
    }
    return { childFile, childSessionId, authoritative };
}

interface ExtractedEntry {
    event?: ExtractedUsageEvent;
    reference?: SubagentReference;
}

/** Extract only documented usage carriers and the direct subagent-link adapter. */
export function extractSessionEntry(
    value: unknown,
    ordinal: number,
    sourceKey: string,
    sourceFile?: string,
    linkBaseDirectory?: string
): ExtractedEntry {
    if (!isRecord(value)) return {};
    const entryId = stringValue(value.id);
    const identity = { entryId, ordinal };

    if (value.type === 'message' && isRecord(value.message)) {
        const message = value.message;
        const role = stringValue(message.role);
        const occurredAt = messageTimestamp(message, value);

        if (role === 'assistant') {
            return {
                event: normalizedEvent(
                    message.usage,
                    {
                        carrier: 'assistant',
                        role,
                        ...identity,
                        occurredAt,
                        provider: stringValue(message.provider),
                        api: stringValue(message.api),
                        model: stringValue(message.model),
                    },
                    'assistant',
                    sourceKey,
                    sourceFile
                ),
            };
        }

        if (role === 'toolResult') {
            const toolName = stringValue(message.toolName);
            const event = normalizedEvent(
                message.usage,
                {
                    carrier: 'tool',
                    role,
                    ...identity,
                    occurredAt,
                    toolName,
                    toolCallId: stringValue(message.toolCallId),
                },
                toolName === 'subagent' ? 'subagent' : 'tool',
                sourceKey,
                sourceFile
            );
            return {
                event,
                reference: childReference(
                    message,
                    sourceFile,
                    linkBaseDirectory,
                    event !== undefined
                ),
            };
        }
        return {};
    }

    if (value.type === 'compaction' || value.type === 'branch_summary') {
        const isCompaction = value.type === 'compaction';
        const occurredAt = timestampFrom(value.timestamp);
        return {
            event: normalizedEvent(
                value.usage,
                {
                    carrier: isCompaction ? 'compaction' : 'branch-summary',
                    ...identity,
                    occurredAt,
                    relatedId: isCompaction
                        ? stringValue(value.firstKeptEntryId)
                        : stringValue(value.fromId),
                },
                isCompaction ? 'compaction' : 'branch-summary',
                sourceKey,
                sourceFile
            ),
        };
    }

    return {};
}

function supportedVersion(value: unknown): number | undefined {
    const version = value === undefined ? 1 : value;
    return typeof version === 'number' &&
        Number.isInteger(version) &&
        version >= 1 &&
        version <= MAX_SUPPORTED_SESSION_VERSION
        ? version
        : undefined;
}

function emptyExtractedSession(options: ExtractSessionEntriesOptions): ExtractedSession {
    const version = supportedVersion(options.version) ?? MAX_SUPPORTED_SESSION_VERSION;
    const sourceFile = options.sourceFile === undefined ? undefined : resolve(options.sourceFile);
    const sourceKey =
        options.sourceKey ??
        (sourceFile === undefined
            ? `memory:${options.sessionId ?? 'current'}`
            : `file:${sourceFile}`);
    return {
        sourceKey,
        sourceFile,
        sessionId: options.sessionId,
        version,
        isSubagentFile: options.isSubagentFile ?? false,
        events: [],
        references: [],
    };
}

function appendExtractedEntry(
    session: ExtractedSession,
    entry: unknown,
    ordinal: number,
    linkBaseDirectory: string | undefined
): void {
    const extracted = extractSessionEntry(
        entry,
        ordinal,
        session.sourceKey,
        session.sourceFile,
        linkBaseDirectory
    );
    if (extracted.event !== undefined) session.events.push(extracted.event);
    if (extracted.reference !== undefined) session.references.push(extracted.reference);
}

/** Normalize in-memory entries synchronously, primarily for small fixtures and adapters. */
export function extractSessionEntries(
    entries: readonly unknown[],
    options: ExtractSessionEntriesOptions = {}
): ExtractedSession {
    const session = emptyExtractedSession(options);
    entries.forEach((entry, ordinal) => {
        appendExtractedEntry(session, entry, ordinal, options.linkBaseDirectory);
    });
    return session;
}

/** Normalize a potentially large current-session snapshot without monopolizing the event loop. */
export async function extractSessionEntriesCooperatively(
    entries: readonly unknown[],
    options: ExtractSessionEntriesOptions = {},
    workOptions: CooperativeWorkOptions = {}
): Promise<ExtractedSession> {
    const checkpoint = createWorkCheckpoint(workOptions);
    const session = emptyExtractedSession(options);
    for (let ordinal = 0; ordinal < entries.length; ordinal++) {
        const pause = checkpoint();
        if (pause !== undefined) await pause;
        appendExtractedEntry(session, entries[ordinal], ordinal, options.linkBaseDirectory);
    }
    workOptions.signal?.throwIfAborted();
    return session;
}

/** Canonicalize only explicit links; linked paths are never opened or recursively scanned. */
export async function canonicalizeSubagentReferences(
    session: ExtractedSession,
    signal?: AbortSignal
): Promise<ExtractedSession> {
    for (const reference of session.references) {
        signal?.throwIfAborted();
        if (reference.childFile === undefined) continue;
        try {
            reference.childFile = await realpath(reference.childFile);
        } catch {
            signal?.throwIfAborted();
            // Keep the lexical path so a concurrently discovered or ID-linked file can match.
        }
    }
    return session;
}

/** Yield complete lines while discarding any record that exceeds the byte limit. */
async function* boundedLines(
    stream: ReadStream,
    maxLineBytes: number,
    signal?: AbortSignal
): AsyncGenerator<string> {
    let chunks: Buffer[] = [];
    let retainedBytes = 0;
    let oversized = false;

    for await (const chunk of stream) {
        signal?.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;

        while (offset < bytes.length) {
            const newline = bytes.indexOf(10, offset);
            const end = newline === -1 ? bytes.length : newline;

            if (!oversized && end > offset) {
                const segment = bytes.subarray(offset, end);
                if (retainedBytes + segment.length <= maxLineBytes) {
                    chunks.push(segment);
                    retainedBytes += segment.length;
                } else {
                    chunks = [];
                    retainedBytes = 0;
                    oversized = true;
                }
            }

            if (newline === -1) break;
            if (!oversized) yield Buffer.concat(chunks, retainedBytes).toString('utf8');
            chunks = [];
            retainedBytes = 0;
            oversized = false;
            offset = newline + 1;
        }
    }

    signal?.throwIfAborted();
    if (!oversized && retainedBytes > 0) {
        yield Buffer.concat(chunks, retainedBytes).toString('utf8');
    }
}

/** Stream one supported session file without loading transcript content into memory. */
export async function parseSessionFile(
    file: DiscoveredSessionFile | string,
    signal?: AbortSignal
): Promise<ExtractedSession | null> {
    signal?.throwIfAborted();
    const suppliedPath = typeof file === 'string' ? file : file.path;
    const sourceFile = await realpath(suppliedPath);
    signal?.throwIfAborted();
    const isSubagentFile =
        typeof file === 'string' ? isSubagentPath(sourceFile) : file.isSubagentFile;
    const sourceKey = `file:${sourceFile}`;
    const stream = createReadStream(sourceFile, { signal });
    let session: ExtractedSession | null = null;
    let ordinal = 0;

    try {
        for await (const line of boundedLines(stream, MAX_JSONL_LINE_BYTES, signal)) {
            signal?.throwIfAborted();
            if (line.trim().length === 0) continue;

            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch {
                continue;
            }
            if (!isRecord(value)) continue;

            if (session === null) {
                if (value.type !== 'session') continue;
                const version = supportedVersion(value.version);
                if (version === undefined) return null;
                session = {
                    sourceKey,
                    sourceFile,
                    sessionId: stringValue(value.id),
                    version,
                    isSubagentFile,
                    events: [],
                    references: [],
                };
                continue;
            }

            const extracted = extractSessionEntry(value, ordinal++, sourceKey, sourceFile);
            if (extracted.event !== undefined) session.events.push(extracted.event);
            if (extracted.reference !== undefined) session.references.push(extracted.reference);
        }
    } finally {
        stream.destroy();
    }

    return session === null ? null : canonicalizeSubagentReferences(session, signal);
}

export interface ScanSessionFilesOptions {
    signal?: AbortSignal;
    concurrency?: number;
}

/** Parse files with bounded concurrency; unreadable individual files are skipped. */
export async function scanSessionFiles(
    files: readonly (DiscoveredSessionFile | string)[],
    options: ScanSessionFilesOptions = {}
): Promise<ExtractedSession[]> {
    const concurrency = Math.max(
        1,
        Math.min(files.length || 1, Math.floor(options.concurrency ?? DEFAULT_PARSE_CONCURRENCY))
    );
    const results: ExtractedSession[] = [];
    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            options.signal?.throwIfAborted();
            const index = nextIndex++;
            if (index >= files.length) return;
            try {
                const session = await parseSessionFile(files[index], options.signal);
                if (session !== null) results.push(session);
            } catch {
                options.signal?.throwIfAborted();
                // An unreadable or concurrently deleted file does not invalidate the scan.
            }
        }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return results.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}
