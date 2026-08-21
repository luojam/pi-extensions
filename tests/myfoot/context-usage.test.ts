import type { ExtensionAPI, ExtensionContext, ToolInfo } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
    estimateStartupContextTokens,
    getFooterContextUsage,
} from '../../extensions/myfoot/context-usage.ts';

const tool = (name: string, description: string): ToolInfo => ({
    name,
    description,
    parameters: Type.Object({ value: Type.String() }),
    sourceInfo: {
        path: `<test:${name}>`,
        source: 'test',
        scope: 'temporary',
        origin: 'top-level',
    },
});

describe('startup context usage', () => {
    it('estimates the system prompt and active tool definitions before provider usage exists', () => {
        const tools = [tool('active', 'Used tool'), tool('inactive', 'Ignored tool')];
        const systemPrompt = 'System instructions';
        const expectedTools = JSON.stringify([
            {
                name: tools[0]?.name,
                description: tools[0]?.description,
                input_schema: tools[0]?.parameters,
            },
        ]);

        expect(estimateStartupContextTokens(systemPrompt, ['active'], tools)).toBe(
            Math.ceil((systemPrompt.length + expectedTools.length) / 4)
        );
    });

    it('adds the startup estimate to message-only usage and marks it as approximate', () => {
        const tools = [tool('read', 'Read files')];
        const ctx = {
            getContextUsage: () => ({ tokens: 12, contextWindow: 1_000, percent: 1.2 }),
            getSystemPrompt: () => 'System prompt',
            sessionManager: { getBranch: () => [] },
        } as unknown as ExtensionContext;
        const pi = {
            getActiveTools: () => ['read'],
            getAllTools: () => tools,
        } as unknown as ExtensionAPI;
        const startupTokens = estimateStartupContextTokens('System prompt', ['read'], tools);

        expect(getFooterContextUsage(ctx, pi)).toEqual({
            tokens: 12 + startupTokens,
            contextWindow: 1_000,
            percent: ((12 + startupTokens) / 1_000) * 100,
            isStartupEstimate: true,
        });
    });
});
