import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSessionEntries, parseSessionFile } from '../session-parser.ts';
import { mergeCurrentSessionSnapshot, reconcileUsageEvents } from '../subagent-reconciliation.ts';

const temporaryDirectories: string[] = [];

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
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input,
    cost: { total: input / 100 },
});

function assistant(id: string, input: number) {
    return {
        type: 'message',
        id,
        parentId: null,
        timestamp: '2025-01-01T00:00:00.000Z',
        message: {
            role: 'assistant',
            provider: 'test',
            model: 'test',
            timestamp: Date.UTC(2025, 0, 1),
            usage: usage(input),
        },
    };
}

function subagentResult(id: string, childFile: string, childSessionId: string, input?: number) {
    return {
        type: 'message',
        id,
        parentId: null,
        timestamp: '2025-01-01T01:00:00.000Z',
        message: {
            role: 'toolResult',
            toolName: 'subagent',
            toolCallId: `call-${id}`,
            timestamp: Date.UTC(2025, 0, 1, 1),
            details: { sessionFile: childFile, sessionId: childSessionId },
            ...(input === undefined ? {} : { usage: usage(input) }),
        },
    };
}

function session(
    sourceFile: string,
    sessionId: string,
    entries: readonly unknown[],
    isSubagentFile = false
) {
    return extractSessionEntries(entries, {
        sourceFile,
        sourceKey: `file:${sourceFile}`,
        sessionId,
        isSubagentFile,
    });
}

describe('subagent reconciliation', () => {
    it('keeps an authoritative parent rollup and suppresses its referenced child', () => {
        const childFile = '/synthetic/sessions/subagents/child.jsonl';
        const parent = session('/synthetic/sessions/parent.jsonl', 'parent', [
            subagentResult('parent-rollup', childFile, 'child', 10),
        ]);
        const child = session(childFile, 'child', [assistant('child-work', 9)], true);

        const events = reconcileUsageEvents([parent, child]);

        expect(events).toHaveLength(1);
        expect(events[0].components.input).toBe(10);
        expect(events[0].origin).toBe('subagent');
    });

    it('canonicalizes a symlinked child reference before authoritative reconciliation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'token-usage-link-'));
        temporaryDirectories.push(directory);
        const childFile = join(directory, 'child.jsonl');
        const childAlias = join(directory, 'child-alias.jsonl');
        const parentFile = join(directory, 'parent.jsonl');
        const fileHeader = (id: string) => ({
            type: 'session',
            version: 3,
            id,
            timestamp: '2025-01-01T00:00:00.000Z',
            cwd: '/synthetic',
        });
        await writeFile(
            childFile,
            `${JSON.stringify(fileHeader('child'))}\n${JSON.stringify(assistant('child-work', 9))}\n`
        );
        await symlink(childFile, childAlias);
        await writeFile(
            parentFile,
            `${JSON.stringify(fileHeader('parent'))}\n${JSON.stringify(
                subagentResult('parent-rollup', childAlias, 'child', 10)
            )}\n`
        );
        const parent = await parseSessionFile(parentFile);
        const child = await parseSessionFile({ path: childFile, isSubagentFile: true });

        const events = reconcileUsageEvents(
            parent === null || child === null ? [] : [parent, child]
        );

        expect(events.map((event) => event.components.input)).toEqual([10]);
    });

    it('uses and classifies a referenced child when its parent has no valid usage', () => {
        const childFile = '/synthetic/custom/child.jsonl';
        const parent = session('/synthetic/custom/parent.jsonl', 'parent', [
            subagentResult('missing-rollup', childFile, 'child'),
        ]);
        const child = session(childFile, 'child', [assistant('child-work', 9)]);

        const events = reconcileUsageEvents([parent, child]);

        expect(events).toHaveLength(1);
        expect(events[0].components.input).toBe(9);
        expect(events[0].origin).toBe('subagent');
    });

    it('classifies an unreferenced physical subagent file as subagent work', () => {
        const child = session(
            '/synthetic/sessions/subagents/orphan.jsonl',
            'orphan',
            [assistant('orphan-work', 7)],
            true
        );

        expect(reconcileUsageEvents([child])[0].origin).toBe('subagent');
    });

    it('suppresses nested descendants transitively beneath an authoritative ancestor', () => {
        const childFile = '/synthetic/subagents/child.jsonl';
        const grandchildFile = '/synthetic/subagents/grandchild.jsonl';
        const parent = session('/synthetic/parent.jsonl', 'parent', [
            subagentResult('parent-rollup', childFile, 'child', 20),
        ]);
        const child = session(
            childFile,
            'child',
            [
                assistant('child-work', 9),
                subagentResult('child-link', grandchildFile, 'grandchild'),
            ],
            true
        );
        const grandchild = session(
            grandchildFile,
            'grandchild',
            [assistant('grandchild-work', 8)],
            true
        );

        const events = reconcileUsageEvents([parent, child, grandchild]);

        expect(events.map((event) => event.components.input)).toEqual([20]);
    });

    it('suppresses copied child prefixes but retains work added after the clone', () => {
        const childFile = '/synthetic/subagents/child.jsonl';
        const copied = assistant('copied-child-work', 9);
        const parent = session('/synthetic/parent.jsonl', 'parent', [
            subagentResult('parent-rollup', childFile, 'child', 10),
        ]);
        const child = session(childFile, 'child', [copied], true);
        const clone = session('/synthetic/child-clone.jsonl', 'clone', [
            { ...copied, parentId: 're-chained-parent' },
            assistant('new-clone-work', 3),
        ]);

        const events = reconcileUsageEvents([parent, child, clone]);

        expect(events.map((event) => event.components.input)).toEqual([10, 3]);
    });

    it('suppresses an authoritative nested rollup copied from a suppressed child', () => {
        const childFile = '/synthetic/subagents/child.jsonl';
        const grandchildFile = '/synthetic/subagents/grandchild.jsonl';
        const copiedNestedRollup = subagentResult(
            'nested-rollup',
            grandchildFile,
            'grandchild',
            30
        );
        const parent = session('/synthetic/parent.jsonl', 'parent', [
            subagentResult('parent-rollup', childFile, 'child', 100),
        ]);
        const child = session(childFile, 'child', [copiedNestedRollup], true);
        const grandchild = session(
            grandchildFile,
            'grandchild',
            [assistant('grandchild-work', 20)],
            true
        );
        const clone = session('/synthetic/child-clone.jsonl', 'clone', [
            { ...copiedNestedRollup, parentId: 're-chained-parent' },
            assistant('new-clone-work', 2),
        ]);

        const events = reconcileUsageEvents([parent, child, grandchild, clone]);

        expect(events.map((event) => event.components.input)).toEqual([100, 2]);
    });

    it('does not follow missing links and resolves a stale path by unique discovered session ID', () => {
        const actualChildFile = '/synthetic/subagents/actual-child.jsonl';
        const parent = session('/synthetic/parent.jsonl', 'parent', [
            subagentResult('fallback', '/stale/path.jsonl', 'child'),
            subagentResult('missing', '/missing/path.jsonl', 'missing'),
        ]);
        const child = session(actualChildFile, 'child', [assistant('child-work', 4)]);

        const events = reconcileUsageEvents([parent, child]);

        expect(events.map((event) => event.components.input)).toEqual([4]);
        expect(events[0].origin).toBe('subagent');
    });

    it('does not use an ambiguous cloned session ID as a link fallback', () => {
        const parent = session('/synthetic/parent.jsonl', 'parent', [
            subagentResult('ambiguous', '/stale/path.jsonl', 'duplicate'),
        ]);
        const first = session('/synthetic/first.jsonl', 'duplicate', [assistant('first', 1)]);
        const second = session('/synthetic/second.jsonl', 'duplicate', [assistant('second', 2)]);

        const events = reconcileUsageEvents([parent, first, second]);

        expect(events.map((event) => event.components.input)).toEqual([1, 2]);
        expect(events.every((event) => event.origin === 'assistant')).toBe(true);
    });
});

describe('current-session merge', () => {
    it('deduplicates a persisted manager snapshot against the same disk entries', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'token-usage-current-'));
        temporaryDirectories.push(directory);
        const file = join(directory, 'current.jsonl');
        const entry = assistant('same-entry', 5);
        await writeFile(
            file,
            `${JSON.stringify({
                type: 'session',
                version: 3,
                id: 'current',
                timestamp: '2025-01-01T00:00:00.000Z',
                cwd: '/synthetic',
            })}\n${JSON.stringify(entry)}\n`
        );
        const disk = await parseSessionFile(file);
        expect(disk).not.toBeNull();

        const merged = await mergeCurrentSessionSnapshot(disk === null ? [] : [disk], {
            id: 'current',
            file,
            directory,
            entries: [entry],
        });

        expect(reconcileUsageEvents(merged)).toHaveLength(1);
    });

    it('includes an ephemeral snapshot', async () => {
        const merged = await mergeCurrentSessionSnapshot([], {
            id: 'ephemeral',
            directory: '/synthetic',
            entries: [assistant('ephemeral-entry', 6)],
        });

        expect(reconcileUsageEvents(merged)[0].components.input).toBe(6);
    });

    it('resolves relative subagent links from an ephemeral snapshot directory', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'token-usage-ephemeral-'));
        temporaryDirectories.push(directory);
        const childFile = join(directory, 'child.jsonl');
        await writeFile(childFile, '');
        const child = session(childFile, 'child', [assistant('child-entry', 8)]);

        const merged = await mergeCurrentSessionSnapshot([child], {
            id: 'ephemeral',
            directory,
            entries: [subagentResult('relative-link', 'child.jsonl', 'unknown-child-id')],
        });

        const events = reconcileUsageEvents(merged);
        expect(events.map((event) => event.components.input)).toEqual([8]);
        expect(events[0].origin).toBe('subagent');
    });
});
