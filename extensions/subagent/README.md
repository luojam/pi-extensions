# Subagent extension

`subagent` runs one serial, one-shot, general-purpose agent in an isolated in-memory `AgentSession` created through Pi's typed SDK. Nested extensions are disabled. The agent has access to the full coding toolset: `read`, `bash`, `edit`, and `write`; shell-based discovery is available through `bash`.

The session has isolated conversation state, tools, prompt, context window, and history, but it is **not an OS sandbox**. It shares the parent process, user permissions, environment, heap, and event loop.

Cancellation is cooperative through `AgentSession.abort()`. There is intentionally no signal or `SIGKILL` fallback. Parent shutdown waits up to three seconds for SDK sessions to settle, then disposes local subscriptions; a tool that ignores cancellation can still remain blocked in the parent process.

Load it with:

```bash
pi -e ./extensions/subagent/index.ts
```
