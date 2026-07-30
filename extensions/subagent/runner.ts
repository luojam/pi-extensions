import { dirname, resolve } from 'node:path';
import {
    InMemoryCredentialStore,
    type AuthResult,
    type Provider,
    type Usage,
} from '@earendil-works/pi-ai';
import {
    type AgentSession,
    type AgentSessionRuntime,
    createAgentSession,
    createAgentSessionRuntime,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    type SessionEntry,
    SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { getSubagentSystemPrompt } from './prompts.ts';
import { addUsage, emptyUsage, truncateModelOutput } from './run-utils.ts';
import { observeSubagentSession } from './session-observer.ts';
import type { SubagentRunnerOptions, SubagentRunnerResult, SubagentRunnerEvent } from './types.ts';

const SHUTDOWN_GRACE_MS = 3_000;

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
    // break private-field access. Proxy request behavior to the effective parent
    // provider and replace only its authentication resolver. Do not inherit
    // refreshModels: the child runtime has a separate empty model store, while a
    // refresh bound to the parent provider can mutate its shared dynamic catalog.
    return new Proxy(provider, {
        get(target, property) {
            if (property === 'auth') return inheritedAuth;
            if (property === 'refreshModels') return undefined;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function usageFromEntries(entries: SessionEntry[]): Usage {
    const usage = emptyUsage();
    for (const entry of entries) {
        if ((entry.type === 'branch_summary' || entry.type === 'compaction') && entry.usage) {
            addUsage(usage, entry.usage);
        } else if (entry.type === 'message') {
            if (entry.message.role === 'assistant') {
                addUsage(usage, entry.message.usage);
            } else if (entry.message.role === 'toolResult' && entry.message.usage) {
                addUsage(usage, entry.message.usage);
            }
        }
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
    private readonly activeCleanups = new Set<Promise<void>>();
    private readonly runs = new Set<Promise<SubagentRunnerResult>>();
    private modelRuntimePromise: Promise<ModelRuntime> | undefined;
    private readonly shutdownController = new AbortController();
    private shutdownPromise: Promise<void> | undefined;
    private shuttingDown = false;

    run(options: SubagentRunnerOptions): Promise<SubagentRunnerResult> {
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
        const settled = await settleWithin(
            [...aborts, ...this.runs, ...this.activeCleanups],
            SHUTDOWN_GRACE_MS
        );
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
        return (this.modelRuntimePromise ??= ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsPath: null,
        }));
    }

    private async runSerial(options: SubagentRunnerOptions): Promise<SubagentRunnerResult> {
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

        let lateCleanup: Promise<void> | undefined;
        try {
            await waitForTurn(previous, signal);
            if (this.shuttingDown) throw new Error('Subagent runner is shutting down');
            return await this.runOne(options, signal, (cleanup) => {
                lateCleanup = cleanup;
            });
        } finally {
            if (lateCleanup) {
                // Cancellation may return to the caller before extension startup
                // settles. Keep the serial gate closed until that session has been
                // torn down so a subsequent reload cannot overlap its extensions.
                void lateCleanup.then(release, release);
            } else {
                release();
            }
        }
    }

    private async runOne(
        options: SubagentRunnerOptions,
        signal: AbortSignal,
        holdGateUntil: (cleanup: Promise<void>) => void
    ): Promise<SubagentRunnerResult> {
        if (signal.aborted) throw createAbortError();

        const emit = (event: SubagentRunnerEvent): void => options.onEvent?.(event);
        emit({ type: 'setup_started' });

        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.create(options.cwd, agentDir, {
            projectTrusted: options.projectTrusted,
        });
        const resourceLoader = new DefaultResourceLoader({
            cwd: options.cwd,
            agentDir,
            settingsManager,
            extensionFactories: [
                {
                    name: 'subagent-nesting-gate',
                    factory(pi) {
                        pi.on('tool_call', (event) => {
                            if (event.toolName !== 'subagent') return;
                            return {
                                block: true,
                                reason: 'Nested subagents are disabled',
                            };
                        });
                    },
                },
            ],
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
        // reload() is not abort-aware. Return cancellation promptly, but keep the
        // serial gate closed until package resolution and extension factories settle
        // so a subsequent reload cannot overlap them.
        const reload = resourceLoader.reload();
        try {
            await raceWithAbort(reload, signal);
        } catch (error) {
            if (signal.aborted) {
                holdGateUntil(
                    reload.then(
                        () => undefined,
                        () => undefined
                    )
                );
                throw createAbortError();
            }
            throw error;
        }
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
            // Resolve once so baseUrl, credentials, headers, and env all come from
            // the same provider-auth snapshot. This is sufficient for Codex auth;
            // model-specific configured headers require an atomic registry API.
            auth = await raceWithAbort(
                options.modelRegistry.getProviderAuth(options.model.provider),
                signal
            );
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
        // atomically resolved provider auth (including base URL and provider env).
        modelRuntime.registerNativeProvider(providerWithInheritedAuth(parentProvider, auth));
        if (signal.aborted) throw createAbortError();
        if (this.shuttingDown) throw new Error('Subagent runner is shutting down');

        const sessionManager = SessionManager.inMemory(options.cwd);
        const runtimeCreation = createAgentSessionRuntime(
            async ({ cwd, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
                const result = await createAgentSession({
                    cwd,
                    agentDir,
                    model: options.model,
                    thinkingLevel: options.thinkingLevel,
                    modelRuntime,
                    excludeTools: ['subagent'],
                    resourceLoader,
                    settingsManager,
                    sessionManager: runtimeSessionManager,
                    sessionStartEvent,
                });
                const diagnostics: [] = [];
                return {
                    ...result,
                    services: {
                        cwd,
                        agentDir,
                        modelRuntime,
                        resourceLoader,
                        settingsManager,
                        diagnostics,
                    },
                    diagnostics,
                };
            },
            { cwd: options.cwd, agentDir, sessionManager }
        );
        let runtime: AgentSessionRuntime;
        let session: AgentSession;
        try {
            runtime = await raceWithAbort(runtimeCreation, signal);
            session = runtime.session;
        } catch (error) {
            if (signal.aborted) {
                // Session creation is not abort-aware. If it eventually finishes,
                // tear down the unobserved session rather than leaking it. Extensions
                // have not been bound yet, so no lifecycle shutdown is required.
                void runtimeCreation
                    .then(async (lateRuntime) => {
                        await settleWithin([lateRuntime.session.abort()], SHUTDOWN_GRACE_MS);
                        lateRuntime.session.dispose();
                    })
                    .catch(() => undefined);
            }
            throw error;
        }

        this.activeSessions.add(session);
        emit({ type: 'session_ready', sessionId: session.sessionId });
        let finishCleanup!: () => void;
        const cleanupDone = new Promise<void>((resolveCleanup) => {
            finishCleanup = resolveCleanup;
        });
        this.activeCleanups.add(cleanupDone);
        void cleanupDone.then(() => this.activeCleanups.delete(cleanupDone));

        let lastStopReason: string | undefined;
        let lastErrorMessage: string | undefined;

        let unsubscribe = (): void => {};
        let abortPromise: Promise<void> | undefined;
        let cleanupTransferred = false;
        const abort = () => {
            abortPromise ??= session.abort();
            void abortPromise.catch(() => undefined);
        };
        const cleanupSession = async (): Promise<void> => {
            try {
                signal.removeEventListener('abort', abort);
                if (abortPromise) await Promise.allSettled([abortPromise]);
                unsubscribe();
                // Keep the session active while lifecycle shutdown runs so shutdownOnce()
                // can still force-dispose it if an extension handler exceeds the grace period.
                // AgentSession.dispose() only releases session resources. The runtime
                // first emits session_shutdown so extensions can clean up their own.
                await runtime.dispose();
                this.activeSessions.delete(session);
            } finally {
                finishCleanup();
            }
        };

        try {
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) {
                abort();
                throw createAbortError();
            }
            if (this.shuttingDown) {
                abort();
                throw new Error('Subagent runner is shutting down');
            }

            unsubscribe = observeSubagentSession(session, emit, (completion) => {
                lastStopReason = completion.stopReason;
                lastErrorMessage = completion.errorMessage;
            });

            // SDK sessions do not start the extension lifecycle until the host binds
            // them. This emits session_start and resources_discover before prompting.
            // Return cancellation promptly, but do not dispose concurrently with a
            // handler that is still mutating extension state.
            const binding = session.bindExtensions({});
            try {
                await raceWithAbort(binding, signal);
            } catch (error) {
                if (!signal.aborted) throw error;

                cleanupTransferred = true;
                const lateCleanup = binding.then(cleanupSession, cleanupSession);
                holdGateUntil(lateCleanup);
                throw createAbortError();
            }
            if (signal.aborted) throw createAbortError();
            if (this.shuttingDown) throw new Error('Subagent runner is shutting down');

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

            emit({ type: 'stats_refreshed', stats: session.getSessionStats() });
            return {
                text: truncateModelOutput(text),
                usage: usageFromEntries(session.sessionManager.getEntries()),
            };
        } catch (error) {
            if (signal.aborted) throw createAbortError();
            throw error;
        } finally {
            if (!cleanupTransferred) await cleanupSession();
        }
    }
}
