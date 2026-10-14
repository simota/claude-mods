# claude-mods

English | [日本語](README.ja.md)

Personal Claude Code mods (function-hook plugins), published as one marketplace.

| Mod | What it does |
| --- | --- |
| `agent-pane` | Live pane of the session's subagents: running ones with elapsed time, finished ones with result and duration |
| `done-gate` | Flags unverified edits, stops repeated failing commands, and blocks git --no-verify |
| `sandbox-lens` | Tallies sandbox denials seen in Bash output and reports them with /sandbox-report |
| `battle-report` | RPG-style battle report after each turn: tokens, edits, lines changed and tool errors, as a toast, a notification and a sound |
| `skill-hint` | Suggests up to three matching skills above the prompt from what was typed; never invokes them. |
| `todo-agent` | Collects #TODO(agent) follow-ups from Claude's replies into a per-project list with a /todos pane. |
| `context-meter` | Band above the prompt with a Gruvbox sparkline of context use per turn, plus tokens and cost |
| `tool-row` | Redraws finished tool-call rows in the terminal as one compact line with a Nerd Font icon, Gruvbox colors and a short stat |
| `image-preview` | Thumbnails of the images a session writes, reads or generates: under the tool's row in the terminal, and in an /images pane |
| `quick-actions` | Hotkey buttons above the prompt after each turn: run checks, review the diff, draft a commit, continue |
| `self-audit` | After each turn, a cached fork of the conversation audits Claude's own reply against the CLAUDE.md reporting rules and flags violations above the prompt |
| `context-diet` | Trims the skill listing to what the project kind needs (off by default); /context-diet shows what was dropped and the tokens saved |
| `browser-cam` | Live pane of the browser Claude drives: the latest screenshot from Claude in Chrome, the page URL and the recent actions |
| `prompt-coach` | Holds back a typed prompt that looks ambiguous (no done-condition, unclear target) and offers to send it as is or add one; off by default |

## Install

At the prompt of a terminal session:

```
/plugin install <mod> --marketplace simota/claude-mods
```

From a shell:

```
claude plugin install <mod> --marketplace simota/claude-mods
```

This repository is private: installing needs read access on GitHub and a git credential for github.com on the machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Usage

Options are set with `/plugin configure <mod>@simota-mods` in a session, or from a shell:

```
echo '{"enabled":"true"}' | claude plugin configure <mod>@simota-mods --values-stdin
```

Option changes apply after a restart. Bands above the prompt stack: each mod draws its row above what the others draw.

### agent-pane

- `/agent-pane` opens the pane: running subagents first with elapsed time, then finished ones with ✓/✗ and duration.
- In a fullscreen terminal the pane opens by itself on the session's first Agent call.
- The status line shows `agents: N running` while any run.

### done-gate

Works on its own, no command:

- A turn that edited files without running a test, lint, typecheck or build afterwards leaves a band: 未検証の変更があります. A later check run or 閉じる clears it.
- The second identical failure of the same Bash command tells Claude to stop retrying and diagnose the root cause (once per command).
- `git commit|push|merge … --no-verify` (and `git commit -n`) is denied.

### sandbox-lens

- `/sandbox-report` lists the sandbox denials seen in Bash output, for this session and all time: denied hosts and paths, counts, last seen, an example command, and which setting would allow each.
- `/sandbox-report reset` clears the record.
- Hints only: it never changes sandbox settings. A loopback or private address keeps its port in the hint (`127.0.0.1:3000`), since an entry without a port opens every port.

### battle-report

After each turn: a toast, a native notification and a sound with that turn's tokens, edits, lines changed (`git diff --shortstat HEAD`) and tool errors.

| Option | Default | |
| --- | --- | --- |
| `sound` | `true` | Glass for a clean turn, Basso with tool errors (afplay, macOS) |
| `notify` | `true` | Native notification besides the toast |

### skill-hint

Typing a prompt shows up to three matching skills above the prompt (`💡 skill候補: /coding-debug …`), only ones that exist in the session. Nothing is invoked; 閉じる or the next prompt clears it. Slash commands and prompts that already name a skill get no hint.

### todo-agent

- Lines `#TODO(agent): <action>` in Claude's replies are collected per project (repo root or cwd).
- `/todos` opens the pane of this project's open items, each with a 完了 button.
- `/todos all` lists every project's items as text.
- The status line shows `TODO(agent): N` while the project has open items.

### context-meter

A band with a sparkline of context use per turn and `ctx 63% ▲4 · in 120k / out 8k · $1.23`; the percentage turns yellow from 50% and red from 80%.

| Option | Default | |
| --- | --- | --- |
| `band` | `true` | Draw the band (samples are recorded either way) |

### tool-row

Finished tool calls are drawn as one compact line with a Nerd Font icon: Edit/Write ` path +A −D`, Read with line count, Bash with duration (red on error), Agent, web and MCP calls. Results are still drawn below by Claude Code. Terminal only.

| Option | Default | |
| --- | --- | --- |
| `compact` | `true` | Off leaves every row as Claude Code draws it |

### image-preview

- Images a session writes, reads, or that a Bash command produces (png, jpg, jpeg, webp, gif) get a thumbnail under that tool's row in the terminal (kitty graphics: Ghostty, kitty).
- `/images` opens a pane, newest first; `h`/`l` step through them.
- Non-PNG files are converted with macOS `sips`.

| Option | Default | |
| --- | --- | --- |
| `inline` | `true` | Thumbnail under the tool row |
| `maxRows` | `12` | Rows a thumbnail may take, 1 to 60 |

### quick-actions

After each turn, hotkey buttons above the prompt:

- after edits: `1: テスト実行`, `2: 差分レビュー` (`/code-review`), `3: コミット` (only fills the prompt; never commits by itself)
- always: `c: 続けて`, `x: 閉じる`

Digits work from an empty prompt; letters once the band has focus (ctrl+x tab or a click).

| Option | Default | |
| --- | --- | --- |
| `actions` | defaults above | JSON array of `{key,label,prompt,mode:'submit'\|'fill',when:'edits'\|'always'}` replacing the defaults; invalid JSON falls back with a toast |

### self-audit

After each reply of at least `minChars` characters, one tool-less fork of the conversation (served mostly from the prompt cache) checks it against the CLAUDE.md rules: claims done without evidence, first line not the result, unverified assertions, bypassed checks, scope inflation. Violations show in red above the prompt; 詳細 or `/self-audit` opens the pane with quotes and the fork's token use.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | |
| `minChars` | `200` | Shorter replies are not audited |

Cost: one extra request per turn on the session's model; a cold cache (after 5 minutes idle or a model switch) resends the whole conversation.

### context-diet

Off by default. When on, the skill listing is trimmed to what the project kind needs (Swift, Android, Rust, web, Python, Go, detected from the repo root and one level below). Coding, quality, planning and research skills are always kept; red-team, persona and operation skills are dropped; image and design skills are dropped for Rust, Python and Go. A dropped skill named in a prompt is still described for that prompt.

- `/context-diet` shows the project kind, what was kept and dropped, and the tokens saved (estimate).
- `/context-diet on|off|reset` overrides the option for this session. Switching rebuilds the listing, so the prompt cache misses once.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `false` | |
| `keep` | | Comma list of names or `prefix*` never dropped; wins over `drop` |
| `drop` | | Comma list of names or `prefix*` always dropped |

### browser-cam

- While Claude drives Chrome (Claude in Chrome tools), a pane shows the latest screenshot, the page title and URL, and the last 8 actions with ✓/✗.
- `/cam` toggles the pane; in a fullscreen terminal it opens by itself on the first browser call.
- The desktop app shows the caption and actions only.

| Option | Default | |
| --- | --- | --- |
| `autoOpen` | `true` | Open on the first browser call (fullscreen terminal) |

### prompt-coach

Off by default. When on, a typed prompt that looks ambiguous (no done-condition and an unclear target, or only evaluative words like いい感じ) is held back, and a band shows what is missing with a suggested rewrite:

- `1: このまま送る` sends it unchanged
- `2: 補足して送る` puts it back with `完了条件: ` to fill in
- `x` puts it back in the prompt

Slash commands, short prompts and prompts typed while a turn runs are not judged. A timeout or error sends the prompt unchanged; the same text is never held twice. Sending can wait up to `timeoutMs`.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `false` | |
| `model` | `claude-haiku-5-5` | Judging model |
| `timeoutMs` | `3000` | 500 to 3000 |

## Develop

```
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
claude --plugin-dir mods/<mod>
```
