import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenReportProvider } from '../provider.ts';
import { createSessionReportProvider } from '../session-report-provider.ts';
import type { TokenUsageSummary } from '../types.ts';

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
        const defaultRoot = join(root, 'default-sessions');
        const activeDirectory = join(root, 'custom-sessions');
        const defaultFile = join(defaultRoot, 'project', 'default.jsonl');
        const currentFile = join(activeDirectory, 'current.jsonl');
        const currentEntry = assistant('current-entry', 2);
        const latestEntry = assistant('latest-entry', 4);
        await writeSession(defaultFile, 'default', [assistant('default-entry', 1)]);
        await writeSession(currentFile, 'current', [currentEntry]);
        const provider = createSessionReportProvider({ defaultSessionRoot: defaultRoot });

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

    it('returns a normal zero report for missing stores', async () => {
        const root = await temporaryDirectory();
        const provider = createSessionReportProvider({
            defaultSessionRoot: join(root, 'missing-default'),
        });

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
        const provider = createSessionReportProvider({
            defaultSessionRoot: join(root, 'missing-default'),
        });

        const report = await provider.load(request(root, [assistant('ephemeral-entry', 6)]));

        expect(report.periods.lifetime.input).toBe(6);
        expect(report.periods.today.input).toBe(6);
    });

    it('propagates cancellation after a real scan starts', async () => {
        const root = await temporaryDirectory();
        const controller = new AbortController();
        const provider = createSessionReportProvider({ defaultSessionRoot: root });

        const loading = provider.load(request(root, [], undefined, controller.signal));
        controller.abort();

        await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    });

    it.sequential('uses the production factory and Pi agent session root', async () => {
        const root = await temporaryDirectory();
        const sessionRoot = join(root, 'sessions');
        await writeSession(join(sessionRoot, 'project', 'production.jsonl'), 'production', [
            assistant('production-entry', 5),
        ]);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = root;

        try {
            const report = await createTokenReportProvider().load(
                request(join(root, 'missing-active'))
            );
            expect(report.periods.lifetime.input).toBe(5);
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
        const provider = createSessionReportProvider({ defaultSessionRoot: root });

        await expect(provider.load(request(root, badEntries))).rejects.toBe(expected);
    });
});
