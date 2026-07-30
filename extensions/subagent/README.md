# Subagent extension

`subagent` runs one serial, one-shot, general-purpose agent in an isolated in-memory `AgentSession` created through Pi's typed SDK. The child loads the extensions configured for its working directory, so extension tools such as `web_search` and extension policy hooks are available. The `subagent` tool itself is excluded and guarded to prevent nested subagent calls. The agent also has access to Pi's default coding tools.

The child discovers extensions independently through `DefaultResourceLoader`. Temporary extension paths supplied only to the parent invocation are not automatically copied to the child. Global, settings-configured, and trusted project extensions are discovered normally.

The session has isolated conversation state, tools, prompt, context window, and history, but it is **not an OS sandbox**. It shares the parent process, user permissions, environment, heap, and event loop.

Cancellation is cooperative through `AgentSession.abort()`. There is intentionally no signal or `SIGKILL` fallback. Parent shutdown waits up to three seconds for SDK sessions to settle, then disposes local subscriptions; a tool that ignores cancellation can still remain blocked in the parent process.

Load it with:

```bash
pi -e ./extensions/subagent/index.ts
```
