import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSessionFiles } from '../../extensions/token-usage/session-discovery.ts';
import {
    extractSessionEntries,
    parseSessionFile,
    scanSessionFiles,
} from '../../extensions/token-usage/session-parser.ts';
import {
    deduplicateUsageEvents,
    reconcileUsageEvents,
} from '../../extensions/token-usage/subagent-reconciliation.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'token-usage-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

const usage = (input: number, cost: unknown = input) => ({
    input,
    output: input + 1,
    cacheRead: input + 2,
    cacheWrite: input + 3,
    totalTokens: 999_999,
    reasoning: 500,
    cost: { total: cost },
});

const header = (id = 'session-id', version: number | null = 3) => ({
    type: 'session',
    ...(version === null ? {} : { version }),
    id,
    timestamp: '2025-01-01T00:00:00.000Z',
    cwd: '/synthetic',
});

async function writeJsonl(path: string, records: readonly unknown[]): Promise<void> {
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

describe('session discovery', () => {
    it('recurses, canonicalizes overlapping roots, and ignores symlinks and non-JSONL files', async () => {
        const root = await temporaryDirectory();
        const nested = join(root, 'project', 'nested');
        await mkdir(nested, { recursive: true });
        await writeFile(join(root, 'root.jsonl'), '');
        await writeFile(join(nested, 'nested.jsonl'), '');
        await writeFile(join(nested, 'ignored.txt'), '');
        await symlink(nested, join(root, 'linked-directory'));
        await symlink(join(root, 'root.jsonl'), join(root, 'linked-file.jsonl'));

        const files = await discoverSessionFiles([root, nested, join(root, 'missing')]);

        expect(files.map((file) => file.path)).toEqual([
            join(nested, 'nested.jsonl'),
            join(root, 'root.jsonl'),
        ]);
    });

    it('marks files beneath a subagents directory', async () => {
        const root = await temporaryDirectory();
        const directory = join(root, 'sessions', 'subagents');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'child.jsonl'), '');

        expect((await discoverSessionFiles([root]))[0].isSubagentFile).toBe(true);
    });

    it('honors cancellation before discovery begins', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            discoverSessionFiles(['/synthetic'], { signal: controller.signal })
        ).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('streaming session parsing', () => {
    it('extracts every documented carrier and ignores nested retained context', async () => {
        const root = await temporaryDirectory();
        const file = join(root, 'session.jsonl');
        const assistant = {
            type: 'message',
            id: 'assistant-id',
            parentId: 'user-id',
            timestamp: '2025-01-02T00:00:00.000Z',
            message: {
                role: 'assistant',
                provider: 'provider',
                api: 'api',
                model: 'model',
                timestamp: Date.UTC(2025, 0, 2, 1),
                usage: usage(1),
                stopReason: 'aborted',
                content: [{ type: 'text', text: 'must not enter a fingerprint' }],
            },
        };
        await writeJsonl(file, [
            header(),
            assistant,
            {
                type: 'message',
                id: 'tool-id',
                parentId: 'assistant-id',
                timestamp: '2025-01-02T02:00:00.000Z',
                message: {
                    role: 'toolResult',
                    toolCallId: 'call-1',
                    toolName: 'other-tool',
                    usage: usage(2, 'invalid'),
                },
            },
            {
                type: 'compaction',
                id: 'compact-id',
                parentId: 'tool-id',
                timestamp: '2025-01-02T03:00:00.000Z',
                usage: usage(3, 0),
                retainedTail: [assistant.message],
            },
            {
                type: 'branch_summary',
                id: 'branch-id',
                parentId: 'user-id',
                fromId: 'compact-id',
                timestamp: '2025-01-02T04:00:00.000Z',
                usage: usage(4),
            },
            {
                type: 'message',
                id: 'invalid-id',
                parentId: 'branch-id',
                timestamp: '2025-01-02T05:00:00.000Z',
                message: {
                    role: 'assistant',
                    usage: { ...usage(10), cacheWrite: -1 },
                },
            },
        ]);

        const parsed = await parseSessionFile(file);

        expect(parsed?.events.map((event) => event.origin)).toEqual([
            'assistant',
            'tool',
            'compaction',
            'branch-summary',
        ]);
        expect(parsed?.events.map((event) => event.components.input)).toEqual([1, 2, 3, 4]);
        expect(parsed?.events.map((event) => event.recordedCostUsd)).toEqual([1, undefined, 0, 4]);
        expect(parsed?.events[0].occurredAt).toBe(Date.UTC(2025, 0, 2, 1));
        expect(parsed?.events[1].occurredAt).toBe(Date.parse('2025-01-02T02:00:00.000Z'));
    });

    it('accepts versions 1 through 3, treats an omitted version as v1, and rejects future versions', async () => {
        const root = await temporaryDirectory();
        const versions = [null, 1, 2, 3, 4] as const;
        const results = [];
        for (const version of versions) {
            const file = join(root, `v${String(version)}.jsonl`);
            await writeJsonl(file, [header(`id-${String(version)}`, version)]);
            results.push(await parseSessionFile(file));
        }

        expect(results.map((result) => result?.version ?? null)).toEqual([1, 1, 2, 3, null]);
    });

    it('skips blank, malformed, and truncated lines without losing usable entries', async () => {
        const root = await temporaryDirectory();
        const file = join(root, 'malformed.jsonl');
        await writeFile(
            file,
            `${JSON.stringify(header())}\n\nnot-json\n${JSON.stringify({
                type: 'message',
                id: 'good',
                parentId: null,
                message: { role: 'assistant', usage: usage(7) },
                timestamp: '2025-01-01T00:00:00.000Z',
            })}\n{"type":"message"`
        );

        expect(
            (await parseSessionFile(file))?.events.map((event) => event.components.input)
        ).toEqual([7]);
    });

    it('propagates cancellation rather than treating it as an unreadable file', async () => {
        const root = await temporaryDirectory();
        const file = join(root, 'session.jsonl');
        await writeJsonl(file, [header()]);
        const controller = new AbortController();
        controller.abort();

        await expect(scanSessionFiles([file], { signal: controller.signal })).rejects.toMatchObject(
            {
                name: 'AbortError',
            }
        );
    });

    it('skips an unreadable or missing individual file in a bounded scan', async () => {
        const root = await temporaryDirectory();
        const valid = join(root, 'valid.jsonl');
        await writeJsonl(valid, [header()]);

        const parsed = await scanSessionFiles([valid, join(root, 'missing.jsonl')], {
            concurrency: 2,
        });

        expect(parsed).toHaveLength(1);
    });

    it('classifies a string path beneath subagents when discovery metadata is absent', async () => {
        const root = await temporaryDirectory();
        const directory = join(root, 'sessions', 'subagents');
        const file = join(directory, 'child.jsonl');
        await mkdir(directory, { recursive: true });
        await writeJsonl(file, [
            header('child'),
            {
                type: 'message',
                id: 'child-work',
                parentId: null,
                timestamp: '2025-01-01T00:00:00.000Z',
                message: { role: 'assistant', usage: usage(7) },
            },
        ]);

        const parsed = await scanSessionFiles([file]);

        expect(parsed[0].isSubagentFile).toBe(true);
        expect((await reconcileUsageEvents(parsed))[0].origin).toBe('subagent');
    });
});

describe('accounting fingerprints', () => {
    it('deduplicates a copied prefix, counts new clone work, and keeps equal usage with distinct IDs', () => {
        const copied = {
            type: 'message',
            id: 'copied-id',
            parentId: null,
            timestamp: '2025-01-01T00:00:00.000Z',
            message: { role: 'assistant', provider: 'p', model: 'm', usage: usage(1) },
        };
        const independent = {
            ...copied,
            id: 'independent-id',
        };
        const added = {
            ...copied,
            id: 'added-id',
            parentId: 'copied-id',
            message: { ...copied.message, usage: usage(2) },
        };
        const first = extractSessionEntries([copied, independent], { sourceKey: 'file:first' });
        const reparentedCopy = { ...copied, parentId: 'different-after-label-filtering' };
        const clone = extractSessionEntries([reparentedCopy, added], { sourceKey: 'file:clone' });

        const events = deduplicateUsageEvents([...first.events, ...clone.events]);

        expect(events.map((event) => event.components.input).sort((a, b) => a - b)).toEqual([
            1, 1, 2,
        ]);
    });

    it('includes normalized usage and cost so conflicting copied records are not collapsed', () => {
        const base = {
            type: 'message',
            id: 'same-id',
            parentId: null,
            timestamp: '2025-01-01T00:00:00.000Z',
            message: { role: 'assistant', provider: 'p', model: 'm', usage: usage(1) },
        };
        const changed = {
            ...base,
            message: { ...base.message, usage: usage(2) },
        };

        const events = [
            ...extractSessionEntries([base], { sourceKey: 'file:first' }).events,
            ...extractSessionEntries([changed], { sourceKey: 'file:second' }).events,
        ];

        expect(deduplicateUsageEvents(events)).toHaveLength(2);
    });
});
