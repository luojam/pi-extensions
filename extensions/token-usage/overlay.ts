import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { processedTokens, subagentShare } from './accounting.ts';
import { formatCompactCount, formatTokenShare, formatUsdCost } from './format.ts';
import type { TokenReport, TokenUsageSummary } from './types.ts';

export type TokenUsageOverlayResult = 'closed';

export const TOKEN_REPORT_PREFERRED_WIDTH = 76;
export const TOKEN_REPORT_MINIMUM_WIDTH = 74;
export const TOKEN_REPORT_HORIZONTAL_MARGIN = 4;
export const TOKEN_REPORT_VERTICAL_MARGIN = 2;

const COLUMN_GAP = '      ';

export interface TokenReportOverlayKeybindings {
    getKeys(keybinding: 'tui.select.cancel'): ReturnType<KeybindingsManager['getKeys']>;
    matches(data: string, keybinding: 'tui.select.cancel'): boolean;
}

export type TokenReportOverlayTheme = Pick<Theme, 'bold' | 'fg'>;

export function getTokenReportOverlayWidth(terminalColumns: number): number {
    return Math.min(TOKEN_REPORT_PREFERRED_WIDTH, terminalColumns - TOKEN_REPORT_HORIZONTAL_MARGIN);
}

export function canFitTokenReport(
    terminalColumns: number,
    terminalRows: number,
    renderedRows: number
): boolean {
    return (
        getTokenReportOverlayWidth(terminalColumns) >= TOKEN_REPORT_MINIMUM_WIDTH &&
        renderedRows + TOKEN_REPORT_VERTICAL_MARGIN <= terminalRows
    );
}

const PERIODS: Array<[string, keyof TokenReport['periods']]> = [
    ['Today', 'today'],
    ['7 days', 'sevenDays'],
    ['30 days', 'thirtyDays'],
    ['Lifetime', 'lifetime'],
];

export class TokenReportOverlay {
    private completed = false;
    private readonly cancelKeys: ReturnType<TokenReportOverlayKeybindings['getKeys']>;
    private readonly report: TokenReport;
    private readonly theme: TokenReportOverlayTheme;
    private readonly keybindings: TokenReportOverlayKeybindings;
    private readonly done: (result: TokenUsageOverlayResult) => void;
    private readonly getTerminalSize: (() => { columns: number; rows: number }) | undefined;

    constructor(
        report: TokenReport,
        theme: TokenReportOverlayTheme,
        keybindings: TokenReportOverlayKeybindings,
        done: (result: TokenUsageOverlayResult) => void,
        getTerminalSize?: () => { columns: number; rows: number }
    ) {
        this.report = report;
        this.theme = theme;
        this.keybindings = keybindings;
        this.done = done;
        this.getTerminalSize = getTerminalSize;
        this.cancelKeys = keybindings.getKeys('tui.select.cancel');
    }

    handleInput(data: string): void {
        const shouldClose =
            this.cancelKeys.length > 0
                ? this.keybindings.matches(data, 'tui.select.cancel')
                : matchesKey(data, 'escape');

        if (shouldClose) this.complete('closed');
    }

    render(width: number): string[] {
        if (width <= 0) return [];

        const reportRows = this.renderReport(width);
        const terminalSize = this.getTerminalSize?.();
        if (
            terminalSize !== undefined &&
            !canFitTokenReport(terminalSize.columns, terminalSize.rows, reportRows.length)
        ) {
            return this.renderTooSmall(width);
        }

        return reportRows;
    }

    invalidate(): void {}

    private renderReport(width: number): string[] {
        const borderInnerWidth = Math.max(0, width - 2);
        const contentWidth = Math.max(0, width - 4);
        const content: string[] = [];

        // The first empty row provides padding below the top border.
        content.push('');
        content.push(this.theme.bold(this.theme.fg('accent', 'Historical token usage')));

        content.push('');
        content.push(this.renderComponentHeader());
        content.push(this.renderComponentValues());

        content.push('');
        content.push(this.renderPeriodHeader());
        for (const [label, key] of PERIODS) {
            content.push(this.renderPeriod(label, this.report.periods[key]));
        }

        content.push('');
        content.push(this.theme.fg('dim', this.closeHint()));

        const top = this.theme.fg('border', `╭${'─'.repeat(borderInnerWidth)}╮`);
        const bottom = this.theme.fg('border', `╰${'─'.repeat(borderInnerWidth)}╯`);
        const rows = content.map((line) => this.boxRow(line, contentWidth));

        // The final truncation also protects unusual themes and post-open terminal resizes.
        return [top, ...rows, bottom].map((line) => truncateToWidth(line, width, '', false));
    }

    private renderTooSmall(width: number): string[] {
        const borderInnerWidth = Math.max(0, width - 2);
        const contentWidth = Math.max(0, width - 4);
        const text = truncateToWidth(
            'Terminal too small for token report',
            contentWidth,
            '',
            false
        );
        const padding = Math.max(0, contentWidth - visibleWidth(text));
        const leftPadding = ' '.repeat(Math.floor(padding / 2));
        const rightPadding = ' '.repeat(Math.ceil(padding / 2));
        const content = `${leftPadding}${this.theme.bold(this.theme.fg('warning', text))}${rightPadding}`;
        const top = this.theme.fg('border', `╭${'─'.repeat(borderInnerWidth)}╮`);
        const bottom = this.theme.fg('border', `╰${'─'.repeat(borderInnerWidth)}╯`);

        return [top, this.boxRow(content, contentWidth), bottom].map((line) =>
            truncateToWidth(line, width, '', false)
        );
    }

    private renderPeriodHeader(): string {
        const widths = this.periodColumnWidths();
        return [
            'Period'.padEnd(widths.label),
            'Tokens'.padStart(widths.tokens),
            'Cost'.padStart(widths.cost),
            'Subagents'.padStart(widths.subagents),
        ].join(COLUMN_GAP);
    }

    private renderPeriod(label: string, summary: TokenUsageSummary): string {
        const widths = this.periodColumnWidths();
        return [
            label.padEnd(widths.label),
            formatCompactCount(processedTokens(summary)).padStart(widths.tokens),
            formatUsdCost(summary.recordedCostUsd).padStart(widths.cost),
            formatTokenShare(subagentShare(summary)).padStart(widths.subagents),
        ].join(COLUMN_GAP);
    }

    private periodColumnWidths(): {
        label: number;
        tokens: number;
        cost: number;
        subagents: number;
    } {
        const summaries = PERIODS.map(([, key]) => this.report.periods[key]);
        return {
            label: Math.max('Period'.length, ...PERIODS.map(([label]) => label.length)),
            tokens: Math.max(
                'Tokens'.length,
                ...summaries.map((summary) => formatCompactCount(processedTokens(summary)).length)
            ),
            cost: Math.max(
                'Cost'.length,
                ...summaries.map((summary) => formatUsdCost(summary.recordedCostUsd).length)
            ),
            subagents: Math.max(
                'Subagents'.length,
                ...summaries.map((summary) => formatTokenShare(subagentShare(summary)).length)
            ),
        };
    }

    private componentColumns(): Array<{ label: string; value: string; width: number }> {
        const lifetime = this.report.periods.lifetime;
        const columns = [
            ['Total', formatCompactCount(processedTokens(lifetime))],
            ['Input', formatCompactCount(lifetime.input)],
            ['Output', formatCompactCount(lifetime.output)],
            ['Cache read', formatCompactCount(lifetime.cacheRead)],
            ['Cache write', formatCompactCount(lifetime.cacheWrite)],
        ];
        return columns.map(([label, value]) => ({
            label: label ?? '',
            value: value ?? '',
            width: Math.max(label?.length ?? 0, value?.length ?? 0),
        }));
    }

    private renderComponentHeader(): string {
        return this.componentColumns()
            .map(({ label, width }) => label.padEnd(width))
            .join(COLUMN_GAP);
    }

    private renderComponentValues(): string {
        return this.componentColumns()
            .map(({ value, width }) => value.padStart(width))
            .join(COLUMN_GAP);
    }

    private closeHint(): string {
        return 'esc close';
    }

    private boxRow(content: string, contentWidth: number): string {
        const safeContent = truncateToWidth(content, contentWidth, '…', true);
        return `${this.theme.fg('border', '│')} ${safeContent} ${this.theme.fg('border', '│')}`;
    }

    private complete(result: TokenUsageOverlayResult): void {
        if (this.completed) return;
        this.completed = true;
        this.done(result);
    }
}
