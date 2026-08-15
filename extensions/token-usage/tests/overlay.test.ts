import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { formatCompactCount, formatTokenShare, formatUsdCost } from '../format.ts';
import {
    TokenReportOverlay,
    type TokenReportOverlayKeybindings,
    type TokenReportOverlayTheme,
} from '../overlay.ts';
import { createSampleTokenReportProvider } from '../sample-report-provider.ts';

const theme: TokenReportOverlayTheme = {
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
};

function keybindings(keys: string[]): TokenReportOverlayKeybindings {
    return {
        getKeys: () => keys as ReturnType<TokenReportOverlayKeybindings['getKeys']>,
        matches: (data) => data === 'configured-cancel',
    };
}

describe('TokenReportOverlay', () => {
    it.each(['default', 'zero', 'formatting-edge', 'layout-edge'] as const)(
        'keeps every %s report line within the supplied width',
        async (variant) => {
            const report = await createSampleTokenReportProvider(variant).load();
            const overlay = new TokenReportOverlay(report, theme, keybindings(['ctrl+x']), vi.fn());

            for (const width of [1, 20, 74, 76, 110]) {
                const lines = overlay.render(width);
                expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
            }

            const text = stripTerminalSequences(overlay.render(110).join('\n'));
            expect(text).toContain('SAMPLE DATA');
            expect(overlay.render(110).length).toBeLessThanOrEqual(30);
        }
    );

    it('uses a compact report hierarchy and aligns table columns', async () => {
        const report = await createSampleTokenReportProvider().load();
        const overlay = new TokenReportOverlay(report, theme, keybindings(['escape']), vi.fn());
        const lines = overlay.render(110).map(stripTerminalSequences);
        const text = lines.join('\n');
        const blankRow = (line: string) => line.slice(1, -1).trim() === '';

        expect(blankRow(lines[1] ?? '')).toBe(true);
        expect(lines.at(-2)).toContain('esc close');
        for (const removedLabel of [
            'Range',
            'Known cost',
            'Unknown cost',
            'Lifetime components',
            'Agent split',
            'Agent         Total',
            'Disclaimer',
            '1 event',
            'Lifetime token totals',
        ]) {
            expect(text).not.toContain(removedLabel);
        }

        const periodHeader = lines.find((line) => line.includes('Period')) ?? '';
        const lifetimeRow = lines.find((line) => line.includes('$18.42')) ?? '';
        expect(periodHeader.indexOf('Tokens') + 'Tokens'.length).toBe(
            lifetimeRow.indexOf('12.8M') + '12.8M'.length
        );
        expect(periodHeader.indexOf('Cost') + 'Cost'.length).toBe(
            lifetimeRow.indexOf('$18.42') + '$18.42'.length
        );
        expect(text.indexOf('Today')).toBeLessThan(text.indexOf('7 days'));
        expect(text.indexOf('7 days')).toBeLessThan(text.indexOf('30 days'));
        expect(text.indexOf('30 days')).toBeLessThan(text.indexOf('Lifetime'));
        expect(periodHeader.indexOf('Subagents') + 'Subagents'.length).toBe(
            lifetimeRow.indexOf('28%') + '28%'.length
        );

        const componentHeader = lines.find((line) => line.includes('Cache read')) ?? '';
        const componentValues = lines.find((line) => line.includes('7.3M')) ?? '';
        for (const [label, value] of [
            ['Total', '12.8M'],
            ['Input', '4.2M'],
            ['Output', '1.1M'],
            ['Cache read', '7.3M'],
            ['Cache write', '250K'],
        ]) {
            expect(componentHeader.indexOf(label) + label.length).toBe(
                componentValues.indexOf(value) + value.length
            );
        }
        expect(text.indexOf('Cache read')).toBeLessThan(text.indexOf('Period'));
    });

    it('shows a centered compact message while the terminal is too small', async () => {
        const report = await createSampleTokenReportProvider().load();
        const terminal = { columns: 100, rows: 18 };
        const overlay = new TokenReportOverlay(
            report,
            theme,
            keybindings(['escape']),
            vi.fn(),
            () => terminal
        );

        const compactLines = overlay.render(96).map(stripTerminalSequences);
        expect(compactLines).toHaveLength(3);
        expect(compactLines[0]).toMatch(/^╭─+╮$/);
        expect(compactLines[2]).toMatch(/^╰─+╯$/);

        const line = compactLines[1] ?? '';
        expect(line).toMatch(/^│ .* │$/);
        expect(line.slice(1, -1).trim()).toBe('Terminal too small for token report');
        const messageStart = line.indexOf('Terminal');
        const messageEnd = messageStart + 'Terminal too small for token report'.length;
        expect(Math.abs(messageStart - (96 - messageEnd))).toBeLessThanOrEqual(1);

        terminal.rows = 40;
        expect(overlay.render(96).length).toBeGreaterThan(1);
    });

    it('closes once through the configured cancel action', async () => {
        const report = await createSampleTokenReportProvider().load();
        const done = vi.fn();
        const overlay = new TokenReportOverlay(report, theme, keybindings(['ctrl+x']), done);

        overlay.handleInput('unrelated');
        overlay.handleInput('configured-cancel');
        overlay.handleInput('configured-cancel');

        expect(done).toHaveBeenCalledTimes(1);
        expect(done).toHaveBeenCalledWith('closed');
    });

    it('uses Escape as a fallback when cancel has no bindings', async () => {
        const report = await createSampleTokenReportProvider().load();
        const done = vi.fn();
        const overlay = new TokenReportOverlay(report, theme, keybindings([]), done);

        overlay.handleInput('\x1b');

        expect(done).toHaveBeenCalledWith('closed');
        expect(stripTerminalSequences(overlay.render(110).join('\n'))).toContain('esc close');
    });
});

describe('formatting', () => {
    it('formats counts, costs, and shares compactly', () => {
        expect(formatCompactCount(999)).toBe('999');
        expect(formatCompactCount(1_250)).toBe('1.3K');
        expect(formatCompactCount(999_999)).toBe('1M');
        expect(formatCompactCount(2_000_000)).toBe('2M');
        expect(formatUsdCost(0)).toBe('$0.00');
        expect(formatUsdCost(0.01)).toBe('$0.01');
        expect(formatUsdCost(1.234)).toBe('$1.23');
        expect(formatUsdCost(0.000123)).toBe('$0.000123');
        expect(formatUsdCost(0.0000001)).toBe('<$0.000001');
        expect(formatTokenShare(0.1234)).toBe('12.3%');
        expect(formatTokenShare(null)).toBe('—');
    });
});
