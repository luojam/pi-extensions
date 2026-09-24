import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenReportProvider } from '../../extensions/mytokens/provider.ts';
import { createSessionReportProvider } from '../../extensions/mytokens/session-report-provider.ts';
import type { TokenUsageSummary } from '../../extensions/mytokens/types.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'token-report-provider-'));
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

const usage = (input: number) => ({
    input,
    output: input + 1,
    cacheRead: input + 2,
    cacheWrite: input + 3,
    totalTokens: 999_999,
    cost: { total: input / 10 },
});

const assistant = (id: string, input: number, timestamp = Date.UTC(2025, 0, 2, 12)) => ({
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: {
        role: 'assistant',
        provider: 'test',
        model: 'test',
        timestamp,
        usage: usage(input),
    },
});

const subagentResult = (id: string, childFile: string, childId: string, input?: number) => ({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2025-01-02T12:00:00.000Z',
    message: {
        role: 'toolResult',
        toolName: 'subagent',
        toolCallId: `call-${id}`,
        timestamp: Date.UTC(2025, 0, 2, 12),
        details: { sessionFile: childFile, sessionId: childId },
        ...(input === undefined ? {} : { usage: usage(input) }),
    },
});

async function writeSession(path: string, id: string, entries: readonly unknown[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const records = [
        {
            type: 'session',
            version: 3,
            id,
            timestamp: '2025-01-02T00:00:00.000Z',
            cwd: '/synthetic',
        },
        ...entries,
    ];
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

const emptySummary = (): TokenUsageSummary => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    recordedCostUsd: 0,
    subagentProcessed: 0,
});

function request(
    directory: string,
    entries: readonly unknown[] = [],
    file?: string,
    signal = new AbortController().signal
) {
    return {
        now: new Date('2025-01-02T13:00:00.000Z'),
        signal,
        currentSession: {
            id: 'current',
            file,
            directory,
            entries,
        },
    } as Parameters<ReturnType<typeof createSessionReportProvider>['load']>[0];
}

describe('session report provider', () => {
    it('scans the default and custom active roots and deduplicates the manager snapshot', async () => {
        const root = await temporaryDirectory();
        const defaultRoot = join(root, 'sessions');
        const activeDirectory = join(root, 'custom-sessions');
        const defaultFile = join(defaultRoot, 'project', 'default.jsonl');
        const currentFile = join(activeDirectory, 'current.jsonl');
        const currentEntry = assistant('current-entry', 2);
        const latestEntry = assistant('latest-entry', 4);
        await writeSession(defaultFile, 'default', [assistant('default-entry', 1)]);
        await writeSession(currentFile, 'current', [currentEntry]);
        const provider = createSessionReportProvider({ agentDirectory: root });

        const report = await provider.load(
            request(activeDirectory, [currentEntry, latestEntry], currentFile)
        );

        expect(report.periods.lifetime).toEqual({
            input: 7,
            output: 10,
            cacheRead: 13,
            cacheWrite: 16,
            recordedCostUsd: 0.7000000000000001,
            subagentProcessed: 0,
        });
        expect(report.periods.today).toEqual(report.periods.lifetime);
        expect(report.periods.sevenDays).toEqual(report.periods.lifetime);
        expect(report.periods.thirtyDays).toEqual(report.periods.lifetime);
    });

    it('counts standalone usage of any kind, deduplicates copies, and attributes child usage', async () => {
        const root = await temporaryDirectory();
        const sessionRoot = join(root, 'sessions');
        const currentFile = join(sessionRoot, 'current.jsonl');
        const cacheWarm: SessionEntry = {
            type: 'usage',
            id: 'cache-warm',
            parentId: null,
            timestamp: '2025-01-02T12:00:00.000Z',
            kind: 'cache_warm',
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            usage: {
                input: 0,
                output: 0,
                cacheRead: 50_000,
                cacheWrite: 0,
                totalTokens: 50_000,
                cost: { input: 0, output: 0, cacheRead: 0.015, cacheWrite: 0, total: 0.015 },
            },
        };
        await writeSession(currentFile, 'current', [cacheWarm]);
        await writeSession(join(sessionRoot, 'clone.jsonl'), 'clone', [
            { ...cacheWarm, parentId: 'reparented' },
        ]);
        await writeSession(join(root, 'pi-subagents', 'sessions', 'child.jsonl'), 'child', [
            { ...cacheWarm, id: 'child-usage', kind: 'future_operation' },
        ]);
        const provider = createSessionReportProvider({ agentDirectory: root });

        const report = await provider.load(request(sessionRoot, [cacheWarm], currentFile));

        const expected = {
            input: 0,
            output: 0,
            cacheRead: 100_000,
            cacheWrite: 0,
            recordedCostUsd: 0.03,
            subagentProcessed: 50_000,
        };
        expect(report.periods).toEqual({
            today: expected,
            sevenDays: expected,
            thirtyDays: expected,
            lifetime: expected,
        });
    });

    it.each(['current', 'migrated'])(
        'reconciles authoritative, fallback, and unreferenced subagent files (%s)',
        async (location) => {
            const root = await temporaryDirectory();
            const sessionRoot = join(root, 'sessions');
            const subagents = join(root, 'pi-subagents', 'sessions');
            // Migration moves transcripts but leaves the parent's recorded paths unchanged.
            const referenceRoot =
                location === 'current' ? subagents : join(sessionRoot, 'subagents');
            await writeSession(join(sessionRoot, 'parent.jsonl'), 'parent', [
                subagentResult(
                    'rollup',
                    join(referenceRoot, 'authoritative.jsonl'),
                    'authoritative',
                    10
                ),
                subagentResult('fallback', join(referenceRoot, 'fallback.jsonl'), 'fallback'),
            ]);
            await writeSession(join(subagents, 'authoritative.jsonl'), 'authoritative', [
                assistant('suppressed-work', 9),
            ]);
            await writeSession(join(subagents, 'fallback.jsonl'), 'fallback', [
                assistant('fallback-work', 4),
            ]);
            await writeSession(join(subagents, 'orphan.jsonl'), 'orphan', [
                assistant('orphan-work', 3),
            ]);
            const provider = createSessionReportProvider({ agentDirectory: root });

            const report = await provider.load(request(sessionRoot));

            expect(report.periods.lifetime).toEqual({
                input: 17,
                output: 20,
                cacheRead: 23,
                cacheWrite: 26,
                recordedCostUsd: 1.7,
                subagentProcessed: 86,
            });
        }
    );

    it('does not treat an empty in-memory session directory as the process directory', async () => {
        const root = await temporaryDirectory();
        await writeSession(join(root, 'unrelated.jsonl'), 'decoy', [
            assistant('unrelated-entry', 90),
        ]);
        const provider = createSessionReportProvider({ agentDirectory: root });
        const previousCwd = process.cwd();

        try {
            process.chdir(root);
            const report = await provider.load(request('', [assistant('ephemeral-entry', 6)]));
            expect(report.periods.lifetime.input).toBe(6);
        } finally {
            process.chdir(previousCwd);
        }
    });

    it('returns a normal zero report for missing stores', async () => {
        const root = await temporaryDirectory();
        const provider = createSessionReportProvider({ agentDirectory: root });

        const report = await provider.load(request(join(root, 'missing-active')));

        expect(report.periods).toEqual({
            today: emptySummary(),
            sevenDays: emptySummary(),
            thirtyDays: emptySummary(),
            lifetime: emptySummary(),
        });
    });

    it('includes active ephemeral usage', async () => {
        const root = await temporaryDirectory();
        const provider = createSessionReportProvider({ agentDirectory: root });

        const report = await provider.load(request(root, [assistant('ephemeral-entry', 6)]));

        expect(report.periods.lifetime.input).toBe(6);
        expect(report.periods.today.input).toBe(6);
    });

    it('propagates cancellation after a real scan starts', async () => {
        const root = await temporaryDirectory();
        const controller = new AbortController();
        const provider = createSessionReportProvider({ agentDirectory: root });

        const loading = provider.load(request(root, [], undefined, controller.signal));
        controller.abort();

        await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    });

    it.sequential('uses the production factory and both Pi agent session roots', async () => {
        const root = await temporaryDirectory();
        const sessionRoot = join(root, 'sessions');
        await writeSession(join(sessionRoot, 'project', 'production.jsonl'), 'production', [
            assistant('production-entry', 5),
        ]);
        await writeSession(join(root, 'pi-subagents', 'sessions', 'orphan.jsonl'), 'orphan', [
            assistant('orphan-entry', 3),
        ]);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = root;

        try {
            const report = await createTokenReportProvider().load(
                request(join(root, 'missing-active'))
            );
            expect(report.periods.lifetime.input).toBe(8);
            expect(report.periods.lifetime.subagentProcessed).toBe(18);
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    });

    it('propagates unexpected orchestration errors', async () => {
        const root = await temporaryDirectory();
        const expected = new Error('snapshot failed');
        const badEntries = new Proxy<unknown[]>([undefined], {
            get(target, property, receiver) {
                if (property === '0') throw expected;
                return Reflect.get(target, property, receiver);
            },
        });
        const provider = createSessionReportProvider({ agentDirectory: root });

        await expect(provider.load(request(root, badEntries))).rejects.toBe(expected);
    });
});
