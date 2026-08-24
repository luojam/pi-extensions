# π extensions

Three TUI extensions for [Pi](https://github.com/earendil-works/pi): a compact startup header, a session footer, and local token accounting.

| Extension | Purpose |
| --- | --- |
| [`myhead`](extensions/myhead) | Compact startup header and shortcut hints |
| [`myfoot`](extensions/myfoot) | Session, context, model, and Codex usage footer |
| [`mytokens`](extensions/mytokens) | Read-only historical token report via `/tokens` |

## Install

```sh
pi install git:github.com/luojam/pi-extensions
```

All three extensions are discovered automatically. Use `pi config` to enable or disable them individually.

To try one from a checkout without installing it:

```sh
pi -e ./extensions/myhead/index.ts
```

## `myhead`

Replaces Pi's startup header with a theme-aware logo, version, and compact shortcut hints.

```text
  ██████
  ██  ██
  ████  ██
  ██    ██

pi v…
esc interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
```

The header keeps this single line of hints when tool output is expanded. Use `/hotkeys` for the full keybinding list. Displayed shortcuts follow the user's keybindings.

## `myfoot`

Replaces the default footer with a responsive two-line view:

```text
╭─ ~/project [main]                                   1m 23s ─ gpt-5.6-sol ─ high ─╮
╰─ W ███████░░░ 74% · 4d 3h                                        42k/272k (16%) ─╯
```

It shows:

- working directory, Git branch, and session name
- elapsed agent time, provider, model, and thinking level
- context tokens, window size, and percentage warnings. Startup estimate is marked with `~`.
- status text published by other extensions
- remaining long-window Codex usage and reset time

Codex usage refreshes at startup, every five minutes, and after the agent settles. It reads Codex credentials from `~/.pi/agent/auth.json`, then `${CODEX_HOME:-~/.codex}/auth.json`, and calls only the [ChatGPT usage endpoint](https://chatgpt.com/backend-api/wham/usage); other footer data stays local.

## `mytokens`

Adds `/tokens`, a read-only report built from local Pi session records.

Example report:

```text
╭──────────────────────────────────────────────────────────────────────────╮
│                                                                          │
│ Historical token usage                                                   │
│                                                                          │
│ Total      Input      Output      Cache read      Cache write            │
│  2.9M       810K        248K            1.8M              36K            │
│                                                                          │
│ Period        Tokens        Cost      Subagents                          │
│ Today          46.3K       $0.18           8.4%                          │
│ 7 days          395K       $1.47          13.9%                          │
│ 30 days         1.6M       $6.82          14.6%                          │
│ Lifetime        2.9M      $12.34            15%                          │
│                                                                          │
│ esc close                                                                │
╰──────────────────────────────────────────────────────────────────────────╯
```

Totals include input, output, cache-read, and cache-write tokens. Period rows show processed tokens, recorded cost, and the token share attributed to subagents. Lifetime means discoverable local history—not provider billing history—and costs are recorded values, not estimates.

The scanner includes the active session, reconciles subagent rollups, and deduplicates copied history from forks and clones. It makes no network requests and never modifies session files.

All extensions are TUI-only. Pi loads the TypeScript sources directly; no build step is required.
