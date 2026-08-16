import { describe, expect, it } from 'vitest';
import {
    aggregateUsageEvents,
    processedTokens,
    recordedCostUsdFromUsage,
    subagentShare,
    tokenComponentsFromUsage,
} from '../accounting.ts';
import type { TokenComponents, TokenUsageSummary, UsageEvent } from '../types.ts';

const components = (input: number): TokenComponents => ({
    input,
    output: input * 2,
    cacheRead: input * 3,
    cacheWrite: input * 4,
});

const event = (
    fingerprint: string,
    input: number,
    occurredAt: number | undefined,
    origin: UsageEvent['origin'] = 'assistant'
): UsageEvent => ({
    fingerprint,
    occurredAt,
    components: components(input),
    recordedCostUsd: input,
    origin,
});

describe('usage validation', () => {
    it('requires all four finite, non-negative token components', () => {
        const valid = { input: 0, output: 1, cacheRead: 2, cacheWrite: 3 };
        expect(tokenComponentsFromUsage(valid)).toEqual(valid);

        for (const invalid of [
            {},
            { ...valid, input: undefined },
            { ...valid, output: -1 },
            { ...valid, cacheRead: Number.NaN },
            { ...valid, cacheWrite: Number.POSITIVE_INFINITY },
            { ...valid, input: '1' },
            null,
        ]) {
            expect(tokenComponentsFromUsage(invalid)).toBeNull();
        }
    });

    it('validates optional recorded cost independently from components', () => {
        expect(recordedCostUsdFromUsage({ cost: { total: 0 } })).toBe(0);
        expect(recordedCostUsdFromUsage({ cost: { total: 1.25 }, input: 'invalid' })).toBe(1.25);

        for (const usage of [
            {},
            { cost: {} },
            { cost: { total: -1 } },
            { cost: { total: Number.NaN } },
            { cost: { total: Number.POSITIVE_INFINITY } },
            { cost: { total: '1.25' } },
        ]) {
            expect(recordedCostUsdFromUsage(usage)).toBeUndefined();
        }
    });
});

describe('summary selectors', () => {
    it('derives processed tokens from the canonical components', () => {
        expect(processedTokens({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })).toBe(100);
    });

    it('derives subagent share and returns null only for a zero denominator', () => {
        const summary: TokenUsageSummary = {
            input: 5,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            recordedCostUsd: 0,
            subagentProcessed: 4,
        };

        expect(subagentShare(summary)).toBe(0.4);
        expect(
            subagentShare({
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                recordedCostUsd: 0,
                subagentProcessed: 0,
            })
        ).toBeNull();
    });
});

describe('aggregateUsageEvents', () => {
    it('uses inclusive local-calendar boundaries and a single cutoff', () => {
        const now = new Date(2025, 5, 15, 12, 34, 56, 789);
        const todayStart = new Date(2025, 5, 15).getTime();
        const sevenDaysStart = new Date(2025, 5, 9).getTime();
        const thirtyDaysStart = new Date(2025, 4, 17).getTime();
        const events = [
            event('today-midnight', 1, todayStart),
            event('before-today', 2, todayStart - 1),
            event('seven-day-start', 4, sevenDaysStart),
            event('before-seven-days', 8, sevenDaysStart - 1),
            event('thirty-day-start', 16, thirtyDaysStart),
            event('before-thirty-days', 32, thirtyDaysStart - 1),
            event('untimestamped', 64, undefined),
            event('invalid-timestamp', 128, Number.NaN),
            event('future', 256, now.getTime() + 1),
            event('at-cutoff', 512, now.getTime()),
        ];

        const report = aggregateUsageEvents(events, now);

        expect(report.periods.today.input).toBe(513);
        expect(report.periods.sevenDays.input).toBe(519);
        expect(report.periods.thirtyDays.input).toBe(543);
        expect(report.periods.lifetime.input).toBe(1023);
        expect(report.periods.lifetime.recordedCostUsd).toBe(1023);
        for (const summary of Object.values(report.periods)) {
            expect(processedTokens(summary)).toBe(
                summary.input + summary.output + summary.cacheRead + summary.cacheWrite
            );
        }
    });

    it('uses calendar days rather than fixed 24-hour durations across daylight saving time', () => {
        const previousTimezone = process.env.TZ;
        process.env.TZ = 'America/New_York';

        try {
            const now = new Date(2025, 2, 10, 12);
            const sevenDaysStart = new Date(2025, 2, 4).getTime();
            expect(now.getTime() - sevenDaysStart).toBe(155 * 60 * 60 * 1000);

            const report = aggregateUsageEvents(
                [
                    event('boundary', 1, sevenDaysStart),
                    event('before-boundary', 2, sevenDaysStart - 1),
                ],
                now
            );

            expect(report.periods.sevenDays.input).toBe(1);
            expect(report.periods.thirtyDays.input).toBe(3);
        } finally {
            if (previousTimezone === undefined) delete process.env.TZ;
            else process.env.TZ = previousTimezone;
        }
    });

    it('counts subagent tokens and ignores invalid cost without dropping valid tokens', () => {
        const now = new Date(2025, 0, 2, 12);
        const events: UsageEvent[] = [
            event('assistant', 1, now.getTime()),
            {
                ...event('subagent', 3, now.getTime(), 'subagent'),
                recordedCostUsd: Number.NaN,
            },
        ];

        const summary = aggregateUsageEvents(events, now).periods.today;

        expect(processedTokens(summary)).toBe(40);
        expect(summary.subagentProcessed).toBe(30);
        expect(subagentShare(summary)).toBe(0.75);
        expect(summary.recordedCostUsd).toBe(1);
    });

    it('silently skips an event with any invalid token component', () => {
        const now = new Date(2025, 0, 2, 12);
        const invalid = {
            ...event('invalid', 1, now.getTime()),
            components: { ...components(1), cacheWrite: -1 },
        };

        const report = aggregateUsageEvents([invalid], now);

        expect(processedTokens(report.periods.lifetime)).toBe(0);
        expect(report.periods.lifetime.recordedCostUsd).toBe(0);
    });
});
