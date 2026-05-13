import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const STATUS_ID = 'codex-usage';
const PROVIDER_LABEL = 'Codex';
const USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REFRESH_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const BAR_WIDTH = 10;

type JsonObject = Record<string, unknown>;

interface UsageWindow {
    label: string;
    usedPercent: number;
    resetsIn?: string;
}

interface UsageState {
    windows: UsageWindow[];
    error?: string;
}

export default function (pi: ExtensionAPI) {
    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    pi.on('session_start', async (_event, ctx) => {
        if (refreshTimer) clearInterval(refreshTimer);

        await refreshUsage(ctx);
        refreshTimer = setInterval(() => void refreshUsage(ctx), REFRESH_INTERVAL_MS);
    });

    pi.on('session_shutdown', () => {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = undefined;
    });

    pi.registerCommand(STATUS_ID, {
        description: 'Refresh Codex usage status bar',
        handler: async (_args, ctx) => {
            await refreshUsage(ctx, true);
        },
    });
}

async function refreshUsage(ctx: ExtensionContext, notify = false) {
    ctx.ui.setStatus(STATUS_ID, `${PROVIDER_LABEL} usage: …`);

    const usage = await fetchCodexUsage();
    const status = renderStatus(usage);

    ctx.ui.setStatus(STATUS_ID, status);
    if (notify) ctx.ui.notify(status, usage.error ? 'warning' : 'info');
}

async function fetchCodexUsage(): Promise<UsageState> {
    const token = getCodexToken();
    if (!token) return usageError('not authenticated');

    try {
        const res = await fetch(USAGE_API_URL, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
                Authorization: `Bearer ${token}`,
                'User-Agent': 'pi-codex-usage-extension',
                Accept: 'application/json',
            },
        });

        if (!res.ok) return usageError(`HTTP ${res.status}`);
        return { windows: parseUsageWindows(await res.json()) };
    } catch (error) {
        return usageError(error instanceof Error ? error.message : String(error));
    }
}

function getCodexToken(): string | undefined {
    const piAuth = readJsonFile(join(homedir(), '.pi', 'agent', 'auth.json'));
    const piToken = stringField(objectField(piAuth, 'openai-codex'), 'access');
    if (piToken) return piToken;

    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    const codexAuth = readJsonFile(join(codexHome, 'auth.json'));
    return stringField(objectField(codexAuth, 'tokens'), 'access_token');
}

function parseUsageWindows(data: unknown): UsageWindow[] {
    const rateLimit = objectField(data, 'rate_limit');

    return [
        parseUsageWindow(objectField(rateLimit, 'primary_window'), '5h'),
        parseUsageWindow(objectField(rateLimit, 'secondary_window'), 'Week'),
    ].filter((usageWindow): usageWindow is UsageWindow => usageWindow !== undefined);
}

function parseUsageWindow(
    raw: JsonObject | undefined,
    fallbackLabel: string,
): UsageWindow | undefined {
    if (!raw) return undefined;

    const resetAt = numberField(raw, 'reset_at');
    const windowSeconds = numberField(raw, 'limit_window_seconds');

    return {
        label: formatWindowLabel(windowSeconds, fallbackLabel),
        usedPercent: clampPercent(raw.used_percent),
        resetsIn: resetAt ? formatResetTime(resetAt) : undefined,
    };
}

function renderStatus(usage: UsageState): string {
    if (usage.error) return `${PROVIDER_LABEL} usage: ${usage.error}`;
    if (usage.windows.length === 0) return `${PROVIDER_LABEL} usage: unavailable`;

    return `${PROVIDER_LABEL} · ${usage.windows.map(renderUsageWindow).join(' · ')}`;
}

function renderUsageWindow({ label, usedPercent, resetsIn }: UsageWindow): string {
    const reset = resetsIn ? ` (⏳${resetsIn})` : '';
    return `${label} ${renderUsageBar(usedPercent)} ${Math.round(usedPercent)}%${reset}`;
}

function renderUsageBar(percent: number): string {
    const filled = Math.round((percent / 100) * BAR_WIDTH);
    return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`;
}

function usageError(error: string): UsageState {
    return { windows: [], error };
}

function clampPercent(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function formatWindowLabel(seconds: number | undefined, fallback: string): string {
    if (!seconds) return fallback;

    const hours = Math.round(seconds / 3600);
    if (hours >= 24 * 6) return 'Week';
    if (hours > 0) return `${hours}h`;
    return fallback;
}

function formatResetTime(epochSeconds: number): string {
    const ms = epochSeconds * 1000 - Date.now();
    if (ms <= 0) return 'now';

    const minutes = Math.ceil(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;

    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

function readJsonFile(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    } catch {
        return undefined;
    }
}

function objectField(value: unknown, key: string): JsonObject | undefined {
    const child = asObject(value)?.[key];
    return asObject(child);
}

function stringField(value: unknown, key: string): string | undefined {
    const child = asObject(value)?.[key];
    return typeof child === 'string' && child.length > 0 ? child : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
    const child = asObject(value)?.[key];
    return typeof child === 'number' && Number.isFinite(child) ? child : undefined;
}

function asObject(value: unknown): JsonObject | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
}
