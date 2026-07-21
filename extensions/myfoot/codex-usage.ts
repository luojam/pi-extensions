import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const FETCH_TIMEOUT_MS = 10_000;
type JsonObject = Record<string, unknown>;

export type UsageLimit =
    | {
          kind: 'usage';
          label: string;
          remainingPercent: number;
          resetAt?: number;
      }
    | { kind: 'message'; text: string };

export async function fetchUsageLimit(signal?: AbortSignal): Promise<UsageLimit> {
    const token = getCodexToken();
    if (!token) return { kind: 'message', text: 'Codex usage: not authenticated' };

    try {
        const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const response = await fetch(USAGE_API_URL, {
            signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'User-Agent': 'pi-myfoot-extension',
            },
        });
        if (!response.ok) {
            return { kind: 'message', text: `Codex usage: HTTP ${response.status}` };
        }

        const data = asObject(await response.json());
        const rateLimit = asObject(data?.rate_limit);
        const usageWindows = [
            asObject(rateLimit?.primary_window),
            asObject(rateLimit?.secondary_window),
        ].filter((window): window is JsonObject => window !== undefined);
        const weeklyWindow = usageWindows.sort(
            (a, b) => Number(b.limit_window_seconds || 0) - Number(a.limit_window_seconds || 0),
        )[0];
        return parseUsageWindow(weeklyWindow, 'W') ?? {
            kind: 'message',
            text: 'Codex usage: unavailable',
        };
    } catch {
        return { kind: 'message', text: 'Codex usage: unavailable' };
    }
}

function parseUsageWindow(window: JsonObject | undefined, label: string): UsageLimit | undefined {
    if (!window) return undefined;

    const used = Number(window.used_percent);
    if (!Number.isFinite(used)) return undefined;

    const remainingPercent = Math.max(0, Math.min(100, 100 - used));
    const resetAt = Number(window.reset_at);
    return {
        kind: 'usage',
        label,
        remainingPercent,
        resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : undefined,
    };
}

function getCodexToken(): string | undefined {
    const piAuth = readJson(join(homedir(), '.pi', 'agent', 'auth.json'));
    const piToken = asObject(piAuth)?.['openai-codex'];
    const access = asObject(piToken)?.access;
    if (typeof access === 'string' && access) return access;

    const codexAuth = readJson(
        join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'),
    );
    const codexAccess = asObject(asObject(codexAuth)?.tokens)?.access_token;
    return typeof codexAccess === 'string' && codexAccess ? codexAccess : undefined;
}

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
        return undefined;
    }
}

function asObject(value: unknown): JsonObject | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
}
