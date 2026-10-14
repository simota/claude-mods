# claude-mods

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

## Develop

```
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
claude --plugin-dir mods/<mod>
```
