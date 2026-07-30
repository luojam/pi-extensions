import { dirname, resolve } from 'node:path';
import type { AuthResult, Provider, Usage } from '@earendil-works/pi-ai';
import {
    type AgentSession,
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    type SessionStats,
    SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { getSubagentSystemPrompt } from './prompts.ts';
import {
    addUsage,
    emptyUsage,
    truncateModelOutput,
    truncateUtf8Tail,
    UPDATE_TEXT_MAX_BYTES,
} from './run-utils.ts';
import type { SubagentDetails, SubagentRunOptions, SubagentRunResult } from './types.ts';

const SHUTDOWN_GRACE_MS = 3_000;
const TEXT_UPDATE_THROTTLE_MS = 100;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createAbortError(message = 'Subagent was aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function providerWithInheritedAuth(provider: Provider, auth: AuthResult): Provider {
    const inheritedAuth = {
        apiKey: {
            name: `Inherited ${provider.name} authentication`,
            check: async () => ({ type: 'api_key' as const, source: auth.source }),
            resolve: async () => auth,
        },
    };

    // Providers may be class instances, so spreading them can discard methods or
    // break private-field access. Proxy all behavior to the effective parent
    // provider and replace only its authentication resolver.
    return new Proxy(provider, {
        get(target, property) {
            if (property === 'auth') return inheritedAuth;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function usageFromStats(stats: SessionStats, assistantUsage: Usage): Usage {
    const usage: Usage = {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        totalTokens: stats.tokens.total,
        cost: {
            input: assistantUsage.cost.input,
            output: assistantUsage.cost.output,
            cacheRead: assistantUsage.cost.cacheRead,
            cacheWrite: assistantUsage.cost.cacheWrite,
            total: stats.cost,
        },
    };
    if (assistantUsage.cacheWrite1h !== undefined) {
        usage.cacheWrite1h = assistantUsage.cacheWrite1h;
    }
    if (assistantUsage.reasoning !== undefined) {
        usage.reasoning = assistantUsage.reasoning;
    }
    return usage;
}

async function settleWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
    if (promises.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            Promise.allSettled(promises).then(() => true),
            new Promise<boolean>((resolveTimeout) => {
                timer = setTimeout(() => resolveTimeout(false), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(createAbortError());

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(createAbortError());

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        previous.then(
            () => {
                signal.removeEventListener('abort', onAbort);
                if (signal.aborted) reject(createAbortError());
                else resolve();
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

export class SubagentRunner {
    private serialTail: Promise<void> = Promise.resolve();
    private readonly activeSessions = new Set<AgentSession>();
    private readonly runs = new Set<Promise<SubagentRunResult>>();
    private modelRuntimePromise: Promise<ModelRuntime> | undefined;
    private readonly shutdownController = new AbortController();
    private shutdownPromise: Promise<void> | undefined;
    private shuttingDown = false;

    run(options: SubagentRunOptions): Promise<SubagentRunResult> {
        if (options.signal?.aborted) return Promise.reject(createAbortError());

        const run = this.runSerial(options);
        this.runs.add(run);
        void run.then(
            () => this.runs.delete(run),
            () => this.runs.delete(run)
        );
        return run;
    }

    shutdown(): Promise<void> {
        return (this.shutdownPromise ??= this.shutdownOnce());
    }

    private async shutdownOnce(): Promise<void> {
        this.shuttingDown = true;
        this.shutdownController.abort();
        const aborts = [...this.activeSessions].map((session) => session.abort());
        const settled = await settleWithin([...aborts, ...this.runs], SHUTDOWN_GRACE_MS);
        if (!settled) {
            // In-process sessions have no hard-kill fallback. Drop local
            // subscriptions after the cooperative grace period so parent
            // shutdown can continue if a tool does not honor abort.
            for (const session of this.activeSessions) session.dispose();
        }
    }

    private getSharedModelRuntime(): Promise<ModelRuntime> {
        // The inherited effective provider is registered for every run. Avoid
        // applying the child's models.json as a second, potentially conflicting
        // provider overlay.
        return (this.modelRuntimePromise ??= ModelRuntime.create({ modelsPath: null }));
    }

    private async runSerial(options: SubagentRunOptions): Promise<SubagentRunResult> {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const previous = this.serialTail;
        this.serialTail = previous.then(
            () => gate,
            () => gate
        );

        const signal = options.signal
            ? AbortSignal.any([options.signal, this.shutdownController.signal])
            : this.shutdownController.signal;

        try {
            await waitForTurn(previous, signal);
            if (this.shuttingDown) throw new Error('Subagent runner is shutting down');
            return await this.runOne(options, signal);
        } finally {
            release();
        }
    }

    private async runOne(
        options: SubagentRunOptions,
        signal: AbortSignal
    ): Promise<SubagentRunResult> {
        if (signal.aborted) throw createAbortError();

        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.create(options.cwd, agentDir, {
            projectTrusted: options.projectTrusted,
        });
        const resourceLoader = new DefaultResourceLoader({
            cwd: options.cwd,
            agentDir,
            settingsManager,
            noExtensions: true,
            appendSystemPrompt: [getSubagentSystemPrompt()],
            // DefaultResourceLoader always discovers AGENTS.md files. Keep trusted
            // global context while excluding project-controlled context when the
            // parent has not trusted the project.
            agentsFilesOverride: options.projectTrusted
                ? undefined
                : (base) => ({
                      agentsFiles: base.agentsFiles.filter(
                          (file) => dirname(resolve(file.path)) === resolve(agentDir)
                      ),
                  }),
        });
        await raceWithAbort(resourceLoader.reload(), signal);
        if (signal.aborted) throw createAbortError();
        if (this.shuttingDown) throw new Error('Subagent runner is shutting down');

        const modelRuntime = await raceWithAbort(this.getSharedModelRuntime(), signal);
        const parentProvider = options.modelRegistry.getProvider(options.model.provider);
        if (!parentProvider) {
            throw new Error(
                `The parent provider for inherited subagent model ${options.model.provider}/${options.model.id} is no longer registered.`
            );
        }

        let auth: AuthResult | undefined;
        try {
            const [providerAuth, requestAuth] = await raceWithAbort(
                Promise.all([
                    options.modelRegistry.getProviderAuth(options.model.provider),
                    options.modelRegistry.getApiKeyAndHeaders(options.model),
                ]),
                signal
            );
            if (!requestAuth.ok) throw new Error(requestAuth.error);
            if (providerAuth) {
                auth = {
                    ...providerAuth,
                    env: requestAuth.env ?? providerAuth.env,
                    auth: {
                        ...providerAuth.auth,
                        apiKey: requestAuth.apiKey ?? providerAuth.auth.apiKey,
                        headers: requestAuth.headers ?? providerAuth.auth.headers,
                    },
                };
            }
        } catch (error) {
            if (signal.aborted) throw createAbortError();
            throw new Error(
                `Unable to authenticate inherited subagent model ${options.model.provider}/${options.model.id}: ${errorMessage(error)}`
            );
        }
        if (!auth) {
            throw new Error(
                `The inherited parent model ${options.model.provider}/${options.model.id} is not authenticated. No fallback model was used.`
            );
        }

        // ModelRegistry is backed by the parent's ModelRuntime and therefore
        // includes --api-key overrides and providers registered by extensions.
        // Install its effective provider in the isolated child runtime with the
        // already-resolved model auth (including headers, base URL, and provider env).
        modelRuntime.registerNativeProvider(providerWithInheritedAuth(parentProvider, auth));
        if (signal.aborted) throw createAbortError();
        if (this.shuttingDown) throw new Error('Subagent runner is shutting down');

        const sessionCreation = createAgentSession({
            cwd: options.cwd,
            agentDir,
            model: options.model,
            thinkingLevel: options.thinkingLevel,
            modelRuntime,
            tools: ['read', 'bash', 'edit', 'write'],
            resourceLoader,
            settingsManager,
            sessionManager: SessionManager.inMemory(options.cwd),
        });
        let session: AgentSession;
        try {
            ({ session } = await raceWithAbort(sessionCreation, signal));
        } catch (error) {
            if (signal.aborted) {
                // Session creation is not abort-aware. If it eventually finishes,
                // tear down the unobserved session rather than leaking it.
                void sessionCreation
                    .then(async ({ session: lateSession }) => {
                        await settleWithin([lateSession.abort()], SHUTDOWN_GRACE_MS);
                        lateSession.dispose();
                    })
                    .catch(() => undefined);
            }
            throw error;
        }

        this.activeSessions.add(session);
        const assistantUsage = emptyUsage();
        let streamedText = '';
        let lastStopReason: string | undefined;
        let lastErrorMessage: string | undefined;
        let stats: SessionStats | undefined;

        const makeDetails = (): SubagentDetails => ({
            id: session.sessionId,
            task: options.task,
            cwd: options.cwd,
            model: { provider: options.model.provider, id: options.model.id },
            thinkingLevel: options.thinkingLevel,
            stats,
        });
        const emitUpdate = (status: string): void => {
            options.onUpdate?.(makeDetails(), status);
        };
        let updateTimer: NodeJS.Timeout | undefined;
        let updateDirty = false;
        let lastUpdateAt = 0;
        const clearUpdateTimer = (): void => {
            if (!updateTimer) return;
            clearTimeout(updateTimer);
            updateTimer = undefined;
        };
        const emitTextUpdate = (): void => {
            if (!updateDirty) return;
            updateDirty = false;
            lastUpdateAt = Date.now();
            emitUpdate(streamedText || '(subagent responding…)');
        };
        const scheduleTextUpdate = (): void => {
            if (!options.onUpdate) return;
            updateDirty = true;
            const delay = TEXT_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
            if (delay <= 0) {
                clearUpdateTimer();
                emitTextUpdate();
                return;
            }
            updateTimer ??= setTimeout(() => {
                updateTimer = undefined;
                emitTextUpdate();
            }, delay);
        };
        const emitToolStatus = (status: string): void => {
            clearUpdateTimer();
            updateDirty = false;
            emitUpdate(status);
        };

        let unsubscribe = (): void => {};
        let abortPromise: Promise<void> | undefined;
        const abort = () => {
            abortPromise ??= session.abort();
            void abortPromise.catch(() => undefined);
        };

        try {
            unsubscribe = session.subscribe((event) => {
                if (
                    event.type === 'message_update' &&
                    event.assistantMessageEvent.type === 'text_delta'
                ) {
                    streamedText = truncateUtf8Tail(
                        streamedText + event.assistantMessageEvent.delta,
                        UPDATE_TEXT_MAX_BYTES
                    );
                    scheduleTextUpdate();
                } else if (event.type === 'tool_execution_start') {
                    emitToolStatus(`Running ${event.toolName}…`);
                } else if (event.type === 'tool_execution_end') {
                    emitToolStatus(`Finished ${event.toolName}…`);
                }

                if (event.type === 'message_end' && event.message.role === 'assistant') {
                    addUsage(assistantUsage, event.message.usage);
                    lastStopReason = event.message.stopReason;
                    lastErrorMessage = event.message.errorMessage;
                }
            });
            signal.addEventListener('abort', abort, { once: true });

            if (signal.aborted) {
                abort();
                throw createAbortError();
            }
            if (this.shuttingDown) {
                abort();
                throw new Error('Subagent runner is shutting down');
            }

            await session.prompt(`Task: ${options.task}`, {
                expandPromptTemplates: false,
            });
            if (signal.aborted) throw createAbortError();

            if (lastStopReason === 'aborted') {
                throw createAbortError(lastErrorMessage || 'Subagent was aborted');
            }
            if (lastStopReason === 'error') {
                throw new Error(lastErrorMessage || 'Subagent stopped with an error');
            }

            const text = session.getLastAssistantText();
            if (!text) throw new Error('Subagent completed without an assistant response');

            stats = session.getSessionStats();
            return {
                text: truncateModelOutput(text),
                details: makeDetails(),
                usage: usageFromStats(stats, assistantUsage),
            };
        } catch (error) {
            if (signal.aborted) throw createAbortError();
            throw error;
        } finally {
            clearUpdateTimer();
            updateDirty = false;
            signal.removeEventListener('abort', abort);
            if (abortPromise) await Promise.allSettled([abortPromise]);
            unsubscribe();
            this.activeSessions.delete(session);
            session.dispose();
        }
    }
}
