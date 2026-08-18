const USD_FORMATTER = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
});

const COMPACT_UNITS = [
    { threshold: 1, suffix: '' },
    { threshold: 1_000, suffix: 'K' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000_000_000, suffix: 'T' },
] as const;

/** Format a non-negative integer using at most one decimal place. */
export function formatCompactCount(value: number): string {
    if (value < 1_000) return String(value);

    let unitIndex = Math.min(Math.floor(Math.log10(value) / 3), COMPACT_UNITS.length - 1);
    let unit = COMPACT_UNITS[unitIndex];
    let rounded = Number((value / unit.threshold).toFixed(1));

    // Avoid boundary output such as "1000K" when rounding reaches the next unit.
    if (rounded >= 1_000 && unitIndex < COMPACT_UNITS.length - 1) {
        unitIndex += 1;
        unit = COMPACT_UNITS[unitIndex];
        rounded = Number((value / unit.threshold).toFixed(1));
    }

    return `${String(rounded)}${unit.suffix}`;
}

/** Format a non-negative US dollar amount without hiding small non-zero values. */
export function formatUsdCost(value: number): string {
    if (value === 0) return '$0.00';
    if (value < 0.000001) return '<$0.000001';
    if (value < 0.01) return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `$${USD_FORMATTER.format(value)}`;
}

/** Format a share as a percentage, or an em dash when no share is available. */
export function formatTokenShare(value: number | null): string {
    if (value === null) return '—';
    return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
}
