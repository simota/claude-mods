# claude-mods

English | [日本語](README.ja.md)

Personal Claude Code mods (function-hook plugins), published as one marketplace.

| Mod | What it does |
| --- | --- |
| `agent-pane` | Live pane of the session's subagents: running ones with elapsed time, finished ones with result and duration |
| `done-gate` | Flags unverified edits, stops repeated failing commands, and blocks git --no-verify |
| `sandbox-lens` | Tallies sandbox denials seen in Bash output and reports them with /sandbox-report |
| `skill-hint` | Suggests up to three matching skills above the prompt from what was typed; never invokes them. |
| `todo-agent` | Collects #TODO(agent) follow-ups from Claude's replies into a per-project list with a /todos pane. |
| `context-meter` | Band above the prompt with a Gruvbox sparkline of context use per turn, plus tokens and cost |
| `tool-row` | Redraws finished tool-call rows in the terminal as one compact line with a Nerd Font icon, Gruvbox colors and a short stat |
| `image-preview` | Thumbnails of the images a session writes, reads or generates: under the tool's row in the terminal, and in an /images pane |
| `self-audit` | After each turn, a cached fork of the conversation audits Claude's own reply against the CLAUDE.md reporting rules and flags violations above the prompt |
| `context-diet` | Trims the skill listing to what the project kind needs (off by default); /context-diet shows what was dropped and the tokens saved |
| `browser-cam` | Live pane of the browser Claude drives: the latest screenshot from Claude in Chrome, the page URL and the recent actions |
| `prompt-coach` | Holds back a typed prompt that looks ambiguous (no done-condition, unclear target) and offers guesses at what it meant, sending it as is, or adding one; on by default |
| `loopback` | Feeds what self-audit, done-gate and sandbox-lens found back to Claude beside the next prompt, instead of only showing it to the person, skipping rules hit-rate found mostly wrong; off by default |
| `zukan` | Error book: catches the errors Bash commands hit across sessions and repos, records what got past each one, and when one comes back tells Claude and the person how it was fixed last time |
| `pr-lamp` | The current branch's pull request as a lamp: checks, review, unresolved threads and what is left before a merge, in the status line and a `/pr` pane; red checks and new review comments go to Claude beside the next prompt |
| `fog-map` | Exploration map: the repository as a tree under fog, cleared where Claude read and marked where it edited, made a file or hit an error, with the importers an edit may have broken unseen; `/map` |
| `assertion-guard` | Catches edits that weaken tests to pass: assertions removed, expectations loosened or rewritten, tests skipped, errors swallowed; asks Claude for the reason beside the edit |
| `negative-space` | When an edit adds authorization, validation or error handling, lists the refusal and boundary-value tests no test touched this session covers; `/negative-space` |
| `mutation-tap` | `/mutate` runs a mutation test limited to the lines changed since HEAD and lists the mutants the tests did not catch |
| `perf-delta` | `/perf` compares a benchmark before and after (a saved baseline, or a git ref in a temporary worktree): median time, peak memory, spread, and whether the change beats the noise |
| `handoff-capsule` | Before a compaction and at session end, keeps the goal, decisions, open items, commands to reproduce and files touched; the next session picks which parts to bring back |
| `port-lantern` | The dev servers the session started: URL, port, whether each still listens, and their latest log lines, in the status line and `/ports` |
| `artifact-shelf` | A shelf of what sessions made (CSV, PDF, HTML, video, patches…), tied to the call and request that made each; `/shelf` searches by kind, word and time |
| `focus-hud` | One status line: goal, target, what is running and for how long, and what the session waits on; `/focus` |
| `side-effect-ledger` | A ledger of what a git diff never shows (push, publish, deploy, PRs, API writes, messages) with outcome, how to undo, and whether the undo was checked; `/ledger` |
| `trust-label` | Labels external text (web, issues, logs, browser pages, services) with its source beside the result and flags candidate injected instructions; a heuristic, never a safety verdict; `/trust` |
| `visual-diff` | Compares browser screenshots of the same URL and size before and after an edit: side by side, a map of changed cells, regions, and the edits in between; `/vdiff` |
| `journey-trace` | Records Claude's browser actions and the expected states as a replayable recipe; `/journey md` for a bug report, `/journey e2e` for a Playwright draft |
| `hit-rate` | Gives each finding of done-gate, assertion-guard, self-audit and zukan a later verdict from what the session did next, keeps each rule's precision across sessions, and names the rules loopback stops feeding; `/hit-rate`; off by default |
| `token-lens` | Checks an element's actual colours, spacing and type against the project's design tokens and lists off-token values with the nearest token; `/token-lens <selector>` |

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

A change made with `/plugin configure` reloads the mod; one made from a shell applies after a restart. Bands above the prompt stack: each mod draws its row above what the others draw.

### agent-pane

- `/agent-pane` opens the pane: running subagents first with elapsed time, then finished ones with ✓/✗ and duration. A background run that left the roster without a result shows `? 結果不明`; a teammate or remote launch shows `↗ 起動済み（追跡外）`.
- In a fullscreen terminal the pane opens by itself once per session, on the first Agent call (a reload does not reopen it).
- The status line shows `agents: N running` while any run.

### done-gate

Works on its own, no command:

- A turn that edited files without a passing test, lint, typecheck or build afterwards leaves a band: 未検証の変更があります. It stays until a check succeeds or 閉じる is pressed. Only the program a command runs counts (`ls build`, `npm ci` are not checks), and only when its exit status is the command's: the check is last, or only `&&` follows it (`npm test | tail` does not count).
- The second identical failure of the same Bash command tells Claude to stop retrying and diagnose the root cause (again after the command has succeeded in between).
- Any git command with `--no-verify` (or a prefix of it from `--no-ver`), and `git commit -n` / `-nm`, is denied, also inside subshells, `$(…)`, backticks, `bash -c "…"`, `eval` and wrappers such as `sudo`/`timeout`. The value of an option (`-m "…"`), a comment or a heredoc never triggers it. So is a git command that moves its hooks for the run (`-c core.hooksPath=…`, `--config-env core.hooksPath=…`) or carries a hook manager's off switch in its environment (`HUSKY=0`, `LEFTHOOK=0`, pre-commit's `SKIP=…`), or moves the hooks through config in its environment (`GIT_CONFIG_KEY_n=core.hooksPath`, `GIT_CONFIG_PARAMETERS`). ANSI-C quoting (`$'--no-\x76erify'`), `env -S "…"`, `bash -c -- '…'` and a shell reading its script from stdin (`bash <<< '…'`, a heredoc, `echo '…' | sh`) are read through. It is a best-effort guard: git aliases (`git ci -n`), a hook path written into config beforehand and an environment exported by an earlier command are not detected.

### sandbox-lens

- `/sandbox-report` lists the sandbox denials seen in Bash output, for this session and all time: denied hosts and paths, counts, last seen, an example command, and which setting would allow each.
- `/sandbox-report reset` clears the record.
- Hints only: it never changes sandbox settings. A loopback or private address keeps its port in the hint (`127.0.0.1:3000`), since an entry without a port opens every port.
- Only a `<sandbox_violations>` block that ends the output, and `Operation not permitted` lines a program printed about itself, are read; a block inside a shown file or page is ignored. Credentials in the example command (tokens, passwords, `Authorization`/`Cookie` and other credential headers such as `X-API-Key`, URL userinfo, keys in env assignments including run-together names such as `PGPASSWORD`, known key shapes) are masked. Each section shows the top 10; when the record is full (200), the least recently seen entry gives way.

### skill-hint

After a prompt is sent, up to three skills matching it show above the prompt (`💡 skill候補: /coding-debug …`), only ones that exist in the session. Nothing is invoked; 閉じる or the next prompt (a slash command included) clears it. A prompt that already names a skill (`/name` anywhere, or a hyphenated skill name such as `coding-debug`) gets no hint; built-in commands such as `/clear` and path segments such as `src/review/` do not count as naming one. Plugin skills (`plugin:name`) are suggested by their full name.

### todo-agent

- Lines starting with `#TODO(agent): <action>` (after an optional quote or list bullet) in Claude's main-loop replies are collected per project (repo root or cwd). A mention inside a sentence, a table or inline code is not a TODO; subagent replies are ignored.
- `/todos` opens the pane of this project's open items, each with a 完了 button.
- `/todos all` lists every project's open items as text, marked as stored data.
- The status line shows `TODO(agent): N` while the project has open items.

### context-meter

A band with a sparkline of context use per turn and `ctx 63% ▲4 · 126k · turn in 120k / out 8k · $1.23`: the context size of the last request, then the whole turn's input/output (shown when the turn reported usage). The percentage turns yellow from 50% and red from 80%.

| Option | Default | |
| --- | --- | --- |
| `band` | `true` | Draw the band (samples are recorded either way) |

### tool-row

Finished tool calls are drawn as one compact line with a Nerd Font icon: Edit/Write ` path +A −D`, Read with line count, Bash (red on error), Agent, web and MCP calls. The result block under a compacted row is hidden, so a call is one line; an errored result stays. A row another mod decorated (an image-preview thumbnail) is left as it is, result included. Runs Claude Code folds into one count line (`Read 3 files, ran 2 shell commands`) stay folded. Terminal only.

| Option | Default | |
| --- | --- | --- |
| `compact` | `true` | Off leaves every row and result as Claude Code draws them |

### image-preview

- Images a session writes, reads, or that a Bash command produces (png, jpg, jpeg, webp, gif) get a thumbnail under that tool's row in the terminal (kitty graphics: Ghostty, kitty).
- `/images` opens a pane, newest first; `h`/`l` step through them.
- Non-PNG files are converted with macOS `sips` after the tool result has gone back, so tool calls never wait on it. Converted files live in a private cache (`$TMPDIR` or `~/.cache`), newest 50 kept.

| Option | Default | |
| --- | --- | --- |
| `inline` | `true` | Thumbnail under the tool row |
| `maxRows` | `12` | Rows a thumbnail may take, 1 to 60 |

### self-audit

After each reply of at least `minChars` characters, one tool-less fork of the conversation (served mostly from the prompt cache), given the reply itself as quoted data, checks it against the CLAUDE.md rules: claims done without evidence, first line not the result, unverified assertions, bypassed checks, scope inflation. Violations show in red above the prompt; 詳細 or `/self-audit` opens the pane with quotes and the fork's token use. Results belong to the latest reply only: when it was not audited, the pane says why.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | |
| `minChars` | `200` | Shorter replies are not audited |

Cost: one extra request per turn on the session's model, plus the reply text (up to 12,000 characters) as uncached input; a cold cache (after 5 minutes idle or a model switch) resends the whole conversation.

### context-diet

Off by default. When on, the skill listing is trimmed to what the project kind needs (Swift, Android, Rust, web, Python, Go, detected from the repo root and one level below). Coding, quality, planning and research skills are always kept; red-team, `dynamic-*`, persona and operation skills are dropped; image, design, `ux-scan` and `brand-scan` are dropped for Rust, Python and Go. Only the main loop's listing is reported. A dropped skill named in a prompt is still described for that prompt.

- `/context-diet` shows the project kind, what was kept and dropped in the latest listing, and the tokens saved (estimate). A listing it cannot read reliably goes out unchanged.
- `/context-diet on|off|reset` overrides the option for this session. Switching rebuilds the listing, so the prompt cache misses once.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `false` | |
| `keep` | | Comma list of names or `prefix*` never dropped; wins over `drop` |
| `drop` | | Comma list of names or `prefix*` always dropped |

### browser-cam

- While Claude drives a browser (Claude in Chrome, Claude Browser, or a remote device's browser), a pane shows the latest screenshot, the page title and URL, and the last 8 actions with ✓/✗. The URL comes only from the navigate call or the tab tools' own header, never from page text.
- `/cam` toggles the pane; in a fullscreen terminal it opens by itself once per session, on the first browser call. Screenshots are decoded only while the pane is open, and written to a private per-session folder that is removed at session end.
- The desktop app shows the title and URL, a caption and the actions, without the picture.

| Option | Default | |
| --- | --- | --- |
| `autoOpen` | `true` | Open on the first browser call (fullscreen terminal) |

### prompt-coach

On by default (`enabled: false` turns it off). A typed prompt that looks ambiguous (no done-condition and an unclear target, or only evaluative words like いい感じ) is held back, and a band shows what is missing with up to three guesses at what it meant (judged along the lines of the `clarify` skill: the likeliest reading first, each a different deliverable with a checkable done-condition):

- `a` / `b` / `d`: a guess goes into the prompt to edit and send (not held again)
- `s: このまま送る` sends it unchanged
- `e: 補足して送る` puts it back with `完了条件: ` to fill in (not held again)
- `q: 閉じる` puts it back in the prompt

Typing another prompt instead sends that one and puts the held text back into the prompt. The held text is never lost: when a send fails or is dropped beneath, or putting words back fails, it stays held with its band (unless another prompt was held since) and its words are shown in a toast; a prompt still held at `/clear` goes straight back into the box, and one held when the session quits comes back at this project's next interactive session start. Words go into an empty box as they are, and are appended after a draft typed meanwhile on a line of their own, never over it.

Slash commands, prompts under 12 or over 1500 characters, prompts with any attachment or an `@` mention, prompts sent by a plugin, and prompts typed while a turn runs are not judged. A timeout or error sends the prompt unchanged; the same text is not held twice (within the last 50 judged). Sending can wait up to `timeoutMs`.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | |
| `model` | `claude-haiku-5-5` | Judging model (alias or id) |
| `timeoutMs` | `3000` | 500 to 3000 |

### loopback

Off by default. When on, the new findings of the detector mods are attached to the next prompt typed at an idle prompt, as context only the model reads, so the correction does not wait for the person to retype it:

- `self-audit`: the violations of the latest audited reply
- `done-gate`: edits with no passing check after them (again after a check passed and new edits were left unverified; 閉じる on its band takes the flag down, and nothing is fed)
- `sandbox-lens`: denials seen this session, each once

Each finding goes back once per session, marked as data that may be wrong for Claude to check before acting. A toast says how many went back and from where. Slash commands, hidden prompts, prompts sent by a plugin and prompts typed while a turn runs carry nothing. A detector that is not installed contributes nothing.

With hit-rate on, the rules it muted are not fed (`sandbox-lens` denials never are muted).

- `/loopback` shows what was fed last and the self-audit repeat rate: of the rules fed back, how many self-audit flagged again on the next audited reply (all sessions). The rate is what the design is judged by (`.genius/decisions/loopback.md`). It also names the rules hit-rate muted.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `false` | |

Cost: the findings ride as extra input on the prompt they are attached to (each quote clipped to 300 characters, at most 12 findings).

### zukan

An error book, kept across sessions and repos. When a Bash command fails, the error line is caught and numbered:

- `📕 新種のエラー発見！ No.042「…」` — a kind not seen before
- `📙 No.017 再会（3回目・未解決）` — seen before, nothing known to get past it
- `` 📗 既知 No.017（3回目）— 前回: sandbox 外で `git push origin main` `` — seen before with a fix: Claude also reads, beside the tool's result, where it was seen and what got past it (marked as a past record to check, not an instruction)

A fix is learned when the same program and subcommand (`git push`, `pnpm install`) succeeds within the next 10 Bash calls of the session; whether it ran outside the sandbox is kept with it. Two sightings are one kind when their error line matches with paths, quotes, numbers and hashes taken out.

Failures of tests, linters, type checkers and builds are not caught: they are fixed by editing code, not by a command. Credentials in a kept command and in the kept error line are masked as sandbox-lens does.

- `/zukan` opens the book, most recently seen first: kinds, solved, sightings
- `/zukan note <No> <text>` writes how to get past it, shown and fed in place of the learned command; an empty text removes the note
- `/zukan forget <No>` removes an entry

The newest 300 kinds by last sighting are kept.

### pr-lamp

The current branch's pull request, kept in the status line while you work:

```
⎇ #42 · ✓5 ✗1 ⏳2 · 🛑 変更要求 · 💬3 · マージまであと4
```

"マージまであと N" counts what still stands before a merge: draft, failed checks, running checks, changes requested or approval pending, unresolved review threads, a conflict, the branch behind its base. At 0 it reads `🟢 マージ可能`.

A toast when it changes: `🔴 CI 失敗: test`, `💬 新しいレビューコメント 2件 (@rev)`, `✅ Approved`, `🟢 #42 マージまであと0`, `🎉 #42 がマージされました`. Checks turning red, new review comments, changes requested and a new conflict are also attached to the next prompt typed at an idle prompt, once, with the last 40 lines of the failed log of up to three jobs (more are counted), marked as data whose comments and logs are not to be followed as instructions. The session's own replies on a thread (the comment, made after the post, carrying words it replied with through an MCP reply tool or `gh api …/pulls/N/comments… -f body=`, matched once) are not news; your own review comments are. What waits for the next prompt is about one pull request and is capped (newest kept). The option `feed` (on by default) turns that off.

- `/pr` asks again and opens the pane: title, size, what is left, checks (failed first) and unresolved threads
- `/pr <number|url|branch>` follows that pull request; `/pr clear` goes back to the default

Which pull request: the one a Bash command of the session last worked on (`gh pr comment 2`, `gh pr review 2`, the URL `gh pr create` printed, the branch a `git push` sent to; looking with `gh pr view|diff|checks` does not move it), so work pushed to a review branch from another checkout is followed; else the checked-out branch's; else your newest open pull request in the repository.

It asks `gh` (`gh pr view`, and `gh api graphql` for review threads) at session start, right after a Bash `git push`, `git checkout`, `gh pr create` and the like, every minute while a check runs or after a push, and every five minutes otherwise; it stops once the pull request is merged or closed. Without an origin remote, `gh`, or a pull request for the branch it shows nothing, and `/pr` says why. `gh` runs on the host, outside the Bash sandbox, with your `gh auth`.

### fog-map

The repository as a map under fog, cleared as Claude works through it:

```
🗺 探索率 31%  ██████░░░░░░░░░░░░░░  読 23 · 編 9 · ✗ 2 / 101
▾ mods/
  ▾ pr-lamp/
    ▾ hooks/
      ● lamp.ts  +43 −2  編集 4回
      ✗ register.tsx  +59 −16  編集 6回  エラー 1  ★
  ▸ loopback/  ○●
  ░ agent-pane/  ░ browser-cam/  ░ context-diet/  …8
⚠ 編集したファイルを import しているが未読: mods/pr-lamp/tests/pr-lamp.test.ts
```

`░` nothing touched yet, `○` read (Read, or `cat`, `sed`, `grep`… in Bash), `●` edited (Edit, Write, NotebookEdit, `sed -i`), `✚` made by the session, `✗` named with a line number by a failed Bash command since its last edit, `★` the file touched last. A directory holding an edit, a new file or an error is open; one only read is closed with its marks beside it; untouched directories and files at a level share one fog row.

Two warnings, each a likely oversight: a file edited without being read, and a file that imports an edited one (JS/TS and Python, found by `git grep`) that was never opened.

- `/map` opens the pane
- The status line keeps `🗺 31% · ●9 · ✗2 · ⚠1`
- A toast at 25, 50, 75 and 100% explored, and when an edit first reaches a new area (`🗺 新しい区域を開拓: mods/zukan/`)

The map is the session's, subagents' calls included; files outside the repository are not mapped. Explored is touched files over `git ls-files`, read again after a checkout, pull, `mv` or `rm`. Outside a git repository only the edit count is shown.

### assertion-guard

On each Edit, Write or MultiEdit it diffs the whole file before and after the call, so an assertion moved within the file is no removal. In test files (by name, or a Rust file with a test module anywhere in it) it flags assertions removed or commented out, a strict matcher turned weak (`toEqual` → `toBeDefined`, `assertEqual` → `assertTrue`, `toThrow(X)` → `toThrow()`), the same assertion now expecting another value, and tests skipped or focused (`it.skip`, `@pytest.mark.skip`, `#[ignore]`, `t.Skip`). In any file it flags errors newly swallowed (`catch {}`, `.catch(() => undefined)`, `except: pass`, `|| true`).

Findings ride beside the edit's result, quoted as data, asking Claude to state each change's reason or revert it. A band above the prompt stays until **確認済み**; **理由を尋ねる** puts the question in the prompt. `/assertion-guard` lists the session's findings. Candidates only: a change that legitimately updates a test is flagged too.

### negative-space

Edits to source files that add authorization (`isAdmin`, `permission`, `403`…), input validation (`validate`, `z.string().max(40)`, `if (x > 100)`…) or error handling (`catch`, `raise`, `Err(`…) become triggers. After the turn, a band lists what the tests touched this session (edited or read, matched to the source by file stem) do not yet try: the refusal, the invalid input, the failure, and each bound N as N-1/N/N+1. A case counts as tried only when such a test both tries it (`403`, `invalid`, `toThrow`…) and names what changed: the function the trigger sits in or a name on its line. **Claude に頼む** puts the list in the prompt; **不要** dismisses it. `/negative-space` lists all candidates.

### mutation-tap

`/mutate [test command]` takes the lines changed since HEAD (`git diff -U0`), makes small mutants of them (comparisons flipped, `&&`↔`||`, booleans, `!` dropped, `+`↔`-`, constants +1; strings, comments and imports left alone), and runs the tests once per mutant after a passing baseline, all in a copy of the repository under `$TMPDIR/claude-mutation-tap/` (a copy-on-write clone with `cp -c` on APFS or `cp --reflink` where the file system has it, a plain copy otherwise; dependencies and build output come along). The working tree is never written, so edits, commits and dev servers meanwhile see nothing of it. The copy is removed at the end, or at the next session start after a reload or crash. The pane lists the survivors: mutants the tests did not catch. `/mutate show`, `/mutate stop`.

| Option | Default | |
| --- | --- | --- |
| `maxMutants` | `20` | spread across changed lines |
| `timeoutSec` | `300` | a run past it counts as caught |
| `testCommand` | `""` | guessed from Makefile, package.json, Cargo.toml, go.mod, pyproject.toml, Package.swift |

The copy takes disk space and time where no clone is possible (a large `node_modules` on a non-APFS disk). Tests run on the host, outside the Bash sandbox.

### perf-delta

- `/perf <command>`: one warm-up and N measured runs; the first time saves a baseline, later runs compare with it
- `/perf base <command>`: measure and save as the baseline
- `/perf ref <git-ref> <command>`: run the ref in a temporary `git worktree`, then the working tree (dependencies not in git, such as `node_modules`, are missing there)
- `/perf show`, `/perf clear [command]`

Time and peak memory come from `/usr/bin/time` (`-l` on macOS, `-v` on GNU). The report gives median, ±stdev, CV and range per side; a difference counts only beyond twice the larger stdev and 1%, and a side with CV over 10% is flagged unsteady.

| Option | Default | |
| --- | --- | --- |
| `runs` | `5` | |
| `timeoutSec` | `300` | |

### handoff-capsule

It follows the session: the person's requests, decision lines and open items from Claude's replies (`#TODO(agent)`, "まだ", the todo list), Bash commands worth rerunning with their last outcome, files edited; credentials in commands masked as zukan does. A capsule is saved before each compaction, at session end, and with `/handoff save` (five per repository). The next session in the repository, or the conversation right after a compaction, shows a band: toggle 目的・決定・未完了・コマンド・ファイル and press **取り込む**; the chosen parts go to Claude beside the next prompt, marked as a record to check against the current state. `/handoff` shows the capsule, `/handoff load` offers the latest again.

### port-lantern

A Bash command run in the background, or a server command (`pnpm dev`, `vite`, `uvicorn`, `rails s`…), is followed: its output file is read every 5 s for local URLs and ports (`--port`, `PORT=` in the command too), and `lsof` says whether a port listens. The status line keeps `🏮 :5173● :8000○`; a toast says when one starts listening or stops. `/ports` opens the pane: URL (press to copy), command, pid, and the latest log lines, errors in red.

### artifact-shelf

Files a call made, with data, document, image, video, audio, patch or archive extensions: a Write's file, a Bash command's `-o`/`--output`/`>`/`tee` targets and converter outputs, and paths a tool's answer names, each checked to have changed during the call. Each is kept with its size, time, the call and the request it answered, per repository across sessions (300). `/shelf [words]` filters by kind (`動画`, `video`), extension (`csv`), time (`今日`, `昨日`, `7d`) and text; the pane filters by kind, and pressing a name copies its path. Files deleted since are marked, not dropped.

### focus-hud

```
🎯 ログインのバグを直して › Writing tests · 📄 auth.ts · ⚙ Bash pnpm test · ⏳ Bash の終了待ち (12s)
```

Goal: the latest request's first line, with the todo in progress. Target: the file, page host or program last acted on. Running: the call under way. Waiting: a permission prompt, a question to you, a tool, subagents, the model, or your input. `/focus` gives the same as lines.

### side-effect-ledger

Bash commands and tool calls that change things outside the working tree: `git push` (the undo written from what push printed: `git push --force-with-lease=main:<new> origin <old>:main`, or `--delete` for a new branch; each push of a chained command gets its own remote's refs, and `git -C dir push` counts), `gh pr|issue|release|repo …`, `gh api -X POST…`, npm/cargo/PyPI/gem publish, docker push, kubectl, helm, terraform, pulumi, cdk, vercel, netlify, fly, wrangler, firebase, gcloud, aws, `curl -X POST|PUT|PATCH|DELETE` to a non-local host, scp/rsync to a remote, MCP tools that create/update/send, and Artifact publish/delete. A failed call gets no undo, except where a part may already have applied (a push keeps the refs it moved; failed infrastructure says it may be partly applied and to check its state first). An undo names what pointed the command elsewhere (`KUBECONFIG`, `HELM_NAMESPACE`, `GH_REPO`, `kubectl --context/-n`), never a token. Dry runs (`--dry-run`, `git push -n`) and reads (`kubectl rollout status`, `terraform state list`, `wrangler pages dev`) are not recorded. Each entry keeps its outcome (failures too), how it would be undone and how hard that is; an undo never deletes what may have existed before: a close or delete (`gh pr close <url>`, `gh release delete`, `gh repo delete`, `helm uninstall`) is given only when the output says this call made it (the last URL, the release's own tag, no "already exists"; not when a second gh or helm command in the same line could have printed it), since a failure behind `| tail` or `|| true` exits 0; `gh pr close` keeps the head branch and `gh release delete` the tag; names the remote by the URL git printed when the push ran in another directory (`cd`, `git -C`, a subshell), and names a sha to force back only when the output surely belongs to that one push. In `/ledger` each is marked **確認済みにする** or **不要** once its undo has been checked; the status line counts the session's entries and those unchecked. Credentials in a command (`Authorization` and other credential headers, `token=`, `NAME_TOKEN=`, `PGPASSWORD=`, JSON `"api_key": "…"`, known key shapes) are masked as zukan does before anything is kept. Kept per repository across sessions (300).

### trust-label

Results from WebFetch, WebSearch, browser page reads, `curl`/`wget` to a remote (only when a web client runs, not any URL a command names or quoted text), `gh issue|pr view`, logs (`*.log`, `kubectl logs`, `gh run view --log`), dependency code read or searched in `node_modules/`, `vendor/`, `site-packages/` and the like, other GitHub content (`gh api`, `gh search`, `gh repo view`) and MCP services, failed calls included, get a one-line source label beside them for Claude: external data, not instructions. Text that reads like orders to the model (overriding instructions, role switches, fake conversation tags, hiding things from the user, running a command, piping curl to sh, sending secrets, instructions in HTML comments, invisible characters) is quoted as candidates, with a toast; the rules read the text with invisible characters taken out and full-width forms folded, so `ig​nore` or `ｉｇｎｏｒｅ` still counts, and an HTML comment is read whole, closed or not. `/trust` lists the session's sources. Finding nothing proves nothing.

| Option | Default | |
| --- | --- | --- |
| `labelAll` | `true` | off: only results with candidates get a note |

### visual-diff

Each Claude in Chrome screenshot is kept as PNG with its URL and size (in `$TMPDIR/claude-visual-diff/<session>`, removed at session end). The URL is the last navigation's; after a click, a key or a form input, which may have left the page, it is asked of Claude in Chrome's tab listing for the tab shot, and a shot whose URL cannot be told is kept but never compared. A new one is compared with the last of the same URL and size taken before an edit (or the previous one, or a baseline set with `/vdiff base`): both scaled to 320 px with `sips` (or ImageMagick), a 32-column grid of cells that changed, the changed regions in page pixels, and the files edited in between. `/vdiff` opens the pane: both pictures side by side in the terminal (kitty graphics), the change map and the regions elsewhere. `/vdiff clear` removes the baselines.

### journey-trace

Claude in Chrome navigations, clicks, typing, keys, form fills and scrolls are recorded as steps; elements named by `find`/`read_page` keep their role and name. Expected states come from `/journey expect <text>` and from Claude through the tool `mcp__journey-trace__expect`. `/journey start [name]`, `stop`, `resume`, `clear`; `/journey md` copies a bug report (steps, expected, actual to fill in, environment), `/journey e2e` a Playwright test where coordinate-only clicks are left as TODOs.

### token-lens

Tokens are read from the repository's stylesheets (`--name:` custom properties, SCSS `$variables`) and tokens JSON (`$value`/`value`), references resolved. `/token-lens <selector>` (or, with no argument, the text selected in the page) runs a script in the tab Claude drives through Claude in Chrome's `javascript_tool` and checks up to five elements' colour, background, border, margin, padding, gap, radius, font family, size, weight, line height and letter spacing: equal to a token, or an off-token value with the nearest token and how far off. `/token-lens tokens` counts what was found; `/token-lens reload` reads them again.

### hit-rate

Off by default. When on, each finding gets a verdict later, from what the session did next, never from a judge model:

| Rule | True (tp) | False (fp) |
| --- | --- | --- |
| `done-gate:unverified` | the first test, lint, typecheck or build after the flag fails | it passes first time |
| `assertion-guard:<kind>` | a later edit undoes the weakening (the old line back, the new one gone, counted against duplicates); an edit that weakened two ways is scored per kind | the person marked it checked and it still stands a whole turn later |
| `self-audit:R1`…`R5` | the next audited reply no longer breaks the rule | it breaks it again |
| `zukan:recall` | the recalled fix is what got past the error | another command did |

What nothing decides counts as unknown: a done-gate band taken down with 閉じる, an error zukan stops waiting on, anything still open at session end. The same error failing again, from another command, is still the same recall. The counts are kept across sessions. A rule with at least `minN` true-or-false verdicts and a precision below `threshold` is named in `muted`, and loopback does not feed it; its detector still draws its band.

- `/hit-rate` lists every rule with TP / FP / unknown, precision and n, the share of unknown verdicts, and this session's latest verdicts. The design is judged by these numbers (`.genius/decisions/hit-rate.md`).

| Option | Default | |
| --- | --- | --- |
| `enabled` | `false` | |
| `minN` | `20` | verdicts a rule needs before it can be muted |
| `threshold` | `0.5` | precision below which a rule is muted, from 0 to 1; another value (such as `50`) is ignored for the default and named in `/hit-rate` |

The verdicts are proxies: a failing check may fail for reasons the edits did not cause, and a rule that does not recur may simply not have come up. A muted rule is no longer fed but keeps being scored, so it can come back.

## Develop

```
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
claude --plugin-dir mods/<mod>
scripts/check-copies.sh
```

Mods share no code, so a few files are copies of another mod's (`mods/zukan/hooks/shell.ts` and `mods/hit-rate/hooks/shell.ts` are done-gate's; `mask.ts` in side-effect-ledger, handoff-capsule and artifact-shelf is zukan's). `scripts/check-copies.sh` fails when a copy drifts.

## License

MIT — see [LICENSE](LICENSE).
