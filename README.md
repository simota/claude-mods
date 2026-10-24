# claude-mods

English | [日本語](README.ja.md)

Personal Claude Code mods (function-hook plugins), published as one marketplace.

| Mod | What it does |
| --- | --- |
| `agent-pane` | Live pane of the session's subagents: running ones with elapsed time, finished ones with result and duration |
| `done-gate` | Flags unverified edits, stops repeated failing commands, and blocks git --no-verify |
| `sandbox-lens` | Tallies sandbox denials seen in Bash output and reports them with /sandbox-report |
| `todo-agent` | Collects #TODO(agent) follow-ups from Claude's replies into a per-project list with a /todos pane. |
| `tool-row` | Redraws finished tool-call rows in the terminal as one compact line with a Nerd Font icon, Gruvbox colors and a short stat |
| `image-preview` | Thumbnails of the images a session writes, reads or generates: under the tool's row in the terminal, and in an /images pane |
| `self-audit` | After each turn, a cached fork of the conversation audits Claude's own reply against the CLAUDE.md reporting rules and flags violations above the prompt |
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
| `port-lantern` | The dev servers the session started: URL, port, whether each still listens, and their latest log lines, in the status line and `/ports` |
| `artifact-shelf` | A shelf of what sessions made (CSV, PDF, HTML, video, patches…), tied to the call and request that made each; `/shelf` searches by kind, word and time |
| `side-effect-ledger` | A ledger of what a git diff never shows (push, publish, deploy, PRs, API writes, messages) with outcome, how to undo, and whether the undo was checked; `/ledger` |
| `visual-diff` | Compares browser screenshots of the same URL and size before and after an edit: side by side, a map of changed cells, regions, and the edits in between; `/vdiff` |
| `journey-trace` | Records Claude's browser actions and the expected states as a replayable recipe; `/journey md` for a bug report, `/journey e2e` for a Playwright draft |
| `hit-rate` | Gives each finding of done-gate, assertion-guard, self-audit and zukan a later verdict from what the session did next, keeps each rule's precision across sessions, and names the rules loopback stops feeding; `/hit-rate`; off by default |
| `token-lens` | Checks an element's actual colours, spacing and type against the project's design tokens and lists off-token values with the nearest token; `/token-lens <selector>` |
| `kachi` | When a check you broke turns green after a real fix, the band above the prompt sweeps green once with a short click, and the result row keeps the score: how many tries, how long it stayed red. Silent the rest of the time, but for one dim line under a check's first red |
| `cross-check` | A second opinion from Codex in one press: the band above the prompt reviews the current diff with `codex exec` in its read-only sandbox, shows the top finding and the count, and puts the findings into the prompt for Claude to fix when asked; `/codex` lists them |
| `ci-rehearsal` | CI before the push, in one press: the band above the prompt runs the push workflows locally with `runthrough`, shows the failing job and step with the count, and puts the failures and their log tails into the prompt for Claude to fix when asked; `/ci` lists every job |
| `stack-dock` | The repository's devrouter stack in one press: the band above the prompt says whether it is unset, stopped or up, starts it with `devrouter up`, shows each service's URL and health in the status line and `/stack`, and puts doctor's findings and the failing logs into the prompt for Claude to fix when asked |

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

- `/agent-pane` opens the pane: running subagents first with elapsed time, then finished ones with ✓/✗ and duration; a background run that was stopped shows `■ 停止`. A background run that left the roster without a result shows `? 結果不明`; a teammate or remote launch shows `↗ 起動済み（追跡外）`.
- In a fullscreen terminal the pane opens by itself once per session, on the first Agent call (a reload does not reopen it).
- The status line shows `agents: N running` while any run.

### done-gate

Works on its own, no command:

- A turn that edited files without a passing test, lint, typecheck or build afterwards leaves a band: 未検証の変更があります. It stays until a check succeeds or 閉じる is pressed; 検証させる puts in the prompt an ask for Claude to run the checks the edits touch and fix what fails, for you to send, as every band's ask does (the band stays until a check passes). Only the program a command runs counts (`ls build`, `npm ci` are not checks), and only when its exit status is the command's: the check is last, or only `&&` follows it (`npm test | tail` does not count).
- The second identical failure of the same Bash command tells Claude to stop retrying and diagnose the root cause (again after the command has succeeded in between).
- Any git command with `--no-verify` (or a prefix of it from `--no-ver`), and `git commit -n` / `-nm`, is denied, also inside subshells, `$(…)`, backticks, `bash -c "…"`, `eval` and wrappers such as `sudo`/`timeout`. The value of an option (`-m "…"`), a comment or a heredoc never triggers it. So is a git command that moves its hooks for the run (`-c core.hooksPath=…`, `--config-env core.hooksPath=…`) or carries a hook manager's off switch in its environment (`HUSKY=0`, `LEFTHOOK=0`, pre-commit's `SKIP=…`), or moves the hooks through config in its environment (`GIT_CONFIG_KEY_n=core.hooksPath`, `GIT_CONFIG_PARAMETERS`). ANSI-C quoting (`$'--no-\x76erify'`), `env -S "…"`, `bash -c -- '…'` and a shell reading its script from stdin (`bash <<< '…'`, a heredoc, `echo '…' | sh`) are read through. It is a best-effort guard: git aliases (`git ci -n`), a hook path written into config beforehand and an environment exported by an earlier command are not detected.

### sandbox-lens

- `/sandbox-report` lists the sandbox denials seen in Bash output, for this session and all time: denied hosts and paths, counts, last seen, an example command, and which setting would allow each.
- `/sandbox-report reset` clears the record.
- Hints only: it never changes sandbox settings. A loopback or private address keeps its port in the hint (`127.0.0.1:3000`), since an entry without a port opens every port.
- A `<sandbox_violations>` block, and `Operation not permitted` lines a program printed about itself, are read. For a command that succeeded or was interrupted, the block is taken from where the engine puts it, apart from the command's own output, so one inside a shown file or page is ignored even when it ends the output. A failed command keeps only its error text: the block that ends it (before an agent-proxy note) is read, and there a block the command printed itself cannot be told from the harness's. Credentials in the example command (tokens, passwords, `Authorization`/`Cookie` and other credential headers such as `X-API-Key`, URL userinfo, keys in env assignments including run-together names such as `PGPASSWORD`, known key shapes) are masked. Each section shows the top 10; when the record is full (200), the least recently seen entry gives way.

### todo-agent

- Lines starting with `#TODO(agent): <action>` (after an optional quote or list bullet) in Claude's main-loop replies are collected per project (repo root or cwd). A mention inside a sentence, a table or inline code is not a TODO; subagent replies are ignored.
- `/todos` opens the pane of this project's open items, each with a 完了 button.
- `/todos all` lists every project's open items as text, marked as stored data.
- The status line shows `TODO(agent): N` while the project has open items.

### tool-row

Finished tool calls are drawn as one compact line with a Nerd Font icon: Edit/Write ` path +A −D`, Read with line count, Bash (red on error), Agent, web and MCP calls. The result block under a compacted row is hidden, so a call is one line; an errored result stays. A row another mod decorated (an image-preview thumbnail) is left as it is, result included. Runs Claude Code folds into one count line (`Read 3 files, ran 2 shell commands`) stay folded. Terminal only.

| Option | Default | |
| --- | --- | --- |
| `compact` | `true` | Off leaves every row and result as Claude Code draws them |

### image-preview

- Images a session writes, reads, or that a Bash command produces (png, jpg, jpeg, webp, gif) get a thumbnail under that tool's row in the terminal (kitty graphics: Ghostty, kitty).
- `/images` opens a pane, newest first; `h`/`l` step through them.
- Non-PNG files are converted with macOS `sips` after the tool result has gone back, so tool calls never wait on it. Converted files live in a private cache (`$TMPDIR` or `~/.cache`), newest 50 kept. A killed session's folder is removed by a later session's start once a day untouched; a running session touches its own every hour (again after a plugin reload), so it is kept while idle, though not across a day the machine sleeps.
- A Bash command and its output are searched for image paths in time linear in their length, before the result goes back. A path split at spaces (`/tmp/a b/x.jpg`) joins at most 8 preceding pieces and 4096 characters; the first 64 paths named are read, and of those the first 4 that exist are shown.

| Option | Default | |
| --- | --- | --- |
| `inline` | `true` | Thumbnail under the tool row |
| `maxRows` | `12` | Rows a thumbnail may take, 1 to 60 |

### self-audit

After each reply of at least `minChars` characters, one tool-less fork of the conversation (served mostly from the prompt cache), given the reply itself as quoted data, checks it against the CLAUDE.md rules: claims done without evidence, first line not the result, unverified assertions, bypassed checks, scope inflation. Only violations of the five rules whose quote is found in the reply are kept (a made-up quote or rule is dropped); the quote is compared past markdown marks, bullets, curly quotes, case, spacing and a closing full stop, and one shortened with … is found piece by piece. Violations show in red above the prompt, in one row (the first and how many); 詳細 or `/self-audit` opens the pane with quotes and the fork's token use. Results belong to the latest reply only: when it was not audited, the pane says why.

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | |
| `minChars` | `200` | Shorter replies are not audited |

Cost: one extra request per turn on the session's model, plus the reply text (up to 12,000 characters) as uncached input; a cold cache (after 5 minutes idle or a model switch) resends the whole conversation.

### browser-cam

- While Claude drives a browser (Claude in Chrome, Claude Browser, or a remote device's browser), a pane shows the latest screenshot, the page title and URL, and the last 8 actions with ✓/✗. The URL comes only from the navigate call or the tab tools' own header, never from page text. Text typed or filled in is shown as its length only (`type ‹7文字›`, counted up to 10,000), since the field may be a password; a URL's secrets (token parameters, userinfo, key-shaped parts) are masked.
- `/cam` toggles the pane; in a fullscreen terminal it opens by itself once per session, on the first browser call. Screenshots are decoded only while the pane is open, and written to a private per-session folder that is removed at session end. A killed session's folder is removed by a later session's start once a day untouched; a running session touches its own every hour (again after a plugin reload), so it is kept while idle, though not across a day the machine sleeps.
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

A fix is learned when the same program and subcommand (`git push`, `pnpm install`; read past a leading `cd`, `export` or `source`, so `cd app && npm install` is `npm install`) succeeds within the next 10 Bash calls of the session; whether it ran outside the sandbox is kept with it. Two sightings are one kind when their error line matches with paths, quotes, numbers and hashes taken out.

Failures of tests, linters, type checkers and builds are not caught: they are fixed by editing code, not by a command. Credentials in a kept command and in the kept error line are masked as sandbox-lens does.

- `/zukan` opens the book, most recently seen first: kinds, solved, sightings
- `/zukan note <No> <text>` writes how to get past it, shown and fed in place of the learned command; an empty text removes the note
- `/zukan forget <No>` removes an entry

The newest 300 kinds by last sighting are kept.

### pr-lamp

The current branch's pull request, kept in the status line while it is open (once merged or closed, a toast says so and the line clears):

```
⎇ #42 · ✓5 ✗1 ⏳2 · 🛑 変更要求 · 💬3 · マージまであと4
```

"マージまであと N" counts what still stands before a merge: draft, failed checks, running checks, changes requested or approval pending, unresolved review threads, a conflict, the branch behind its base. At 0 it reads `🟢 マージ可能`.

A toast when it changes: `🔴 CI 失敗: test`, `💬 新しいレビューコメント 2件 (@rev)`, `✅ 承認されました`, `🟢 #42 マージまであと0`, `🎉 #42 がマージされました`. Checks turning red, new review comments, changes requested and a new conflict are also attached to the next prompt typed at an idle prompt, once, with the last 40 lines of the failed log of up to three jobs (more are counted), marked as data whose comments and logs are not to be followed as instructions. The session's own replies on a thread (the comment, made after the post, carrying words it replied with through an MCP reply tool or `gh api …/pulls/N/comments… -f body=`, matched once) are not news; your own review comments are. What waits for the next prompt is about one pull request and is capped (newest kept). The option `feed` (on by default) turns that off.

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
  ░ agent-pane/  ░ browser-cam/  ░ done-gate/  …8
⚠ 編集したファイルを import しているが未読: mods/pr-lamp/tests/pr-lamp.test.ts
```

`░` nothing touched yet, `○` read (Read, or `cat`, `sed`, `grep`… in Bash), `●` edited (Edit, Write, NotebookEdit, `sed -i`), `✚` made by the session, `✗` named with a line number by a failed Bash command since its last edit, `★` the file touched last. A directory holding an edit, a new file or an error is open; one only read is closed with its marks beside it; untouched directories and files at a level share one fog row.

Two warnings, each a likely oversight: a file edited without being read, and a file that imports an edited one (JS/TS and Python, found by `git grep`) that was never opened. A very large repository's file list is cut to what one state value holds (3 M characters of paths), so it is still mapped, partly.

- `/map` opens the pane
- The status line shows `🗺 31% · ●9 · ✗2 · ⚠1` only while there is an error or a warning, and clears otherwise
- A toast at 25, 50, 75 and 100% explored, and when an edit first reaches a new area (`🗺 新しい区域を開拓: mods/zukan/`)

The map is the session's, subagents' calls included; files outside the repository are not mapped. Explored is touched files over `git ls-files`, read again after a checkout, pull, `mv` or `rm`. Outside a git repository only the edit count is shown. A failed command's output is read once, in time linear in its length, before its result goes back.

### assertion-guard

On each Edit, Write or MultiEdit it diffs the whole file before and after the call, so an assertion moved within the file is no removal, and one only reformatted (spaces around punctuation, a closing `;` or `,`, and `'…'` for `"…"` in languages that read them alike) is no rewrite; a change inside a string still is. In test files (by name, or a Rust file with a test module anywhere in it) it flags assertions removed or commented out, a strict matcher turned weak (`toEqual` → `toBeDefined`, `assertEqual` → `assertTrue`, `toThrow(X)` → `toThrow()`), an assertion now about a literal (`expect(true).toBe(true)`), the same assertion now expecting another value or the opposite (`toBe` → `not.toBe`), and tests skipped or focused (`it.skip`, `@pytest.mark.skip`, `#[ignore]`, `t.Skip`). In any file but prose (`.md`, `.txt`, `.rst`, `.adoc`) it flags errors newly swallowed (`catch {}`, `.catch(() => undefined)`, `except: pass`, `|| true`); one named in a comment (`// or || true`, a doc block, `/* … */`, `# …`) is not.

Findings ride beside the edit's result, quoted as data, asking Claude to state each change's reason or revert it. A band above the prompt stays until **確認済み**; **理由を尋ねる** puts the question in the prompt. `/assertion-guard` lists the session's findings. Candidates only: a change that legitimately updates a test is flagged too. It reads changed lines, so an assertion disabled without touching its line (a block comment around it, an early `return` before it) goes unseen.

### negative-space

Edits to source files that add authorization (`isAdmin`, `permission`, `403`…), input validation (`validate`, `z.string().max(40)`, `if (x > 100)`…) or error handling (`catch`, `raise`, `Err(`…) become triggers. Words inside a string or a regex literal (`/permission denied/`) and `Math.max(`/`Math.min(`, which only clamp a value, do not. After the turn, a band lists what the tests touched this session (edited or read, matched to the source by file stem; each held as what it tries, its names and its numbers, Read's line numbers left out, under 1.5 MB in all, a test some trigger's file needs kept longest) do not yet try: the refusal, the invalid input, the failure, and each bound N as N-1/N/N+1. A case counts as tried only when such a test both tries it (`403`, `invalid`, `toThrow`…) and names what changed: the function the trigger sits in or a name on its line. **Claude に頼む** puts the list in the prompt; **不要** dismisses it. `/negative-space` lists all candidates.

### mutation-tap

`/mutate [test command]` takes the lines changed since HEAD (`git diff -U0`, and every line of a new file not yet added: up to 20 such files of up to 200 KB each), makes small mutants of them (comparisons flipped, `&&`↔`||`, booleans, `!` dropped, `+`↔`-`, constants +1; strings, comments and imports left alone), and runs the tests once per mutant after a passing baseline, all in a copy of the repository under `$TMPDIR/claude-mutation-tap/` (`~/.cache/claude-mutation-tap/` where `TMPDIR` is unset) (a copy-on-write clone with `cp -c` on APFS or `cp --reflink` where the file system has it, a plain copy otherwise; dependencies and build output come along). The working tree is never written, so edits, commits and dev servers meanwhile see nothing of it. The copy is removed at the end, or after a reload or crash by a session starting once its run has been quiet for 30 minutes (never one another session is running in; a copy an earlier version left, which records only when it was made, after 3 hours). A run whose copy is taken away, even in part, fails rather than counting its mutants as caught. Compiled Python is dropped from the copy and not written while tests run, so a mutant never runs the bytecode of the line before it. When every mutant survives, the pane says the tests may be reading the original tree rather than the copy (an editable install, an absolute path, a prebuilt `dist`). The pane lists the survivors: mutants the tests did not catch. `/mutate show`, `/mutate stop`.

| Option | Default | |
| --- | --- | --- |
| `maxMutants` | `20` | spread across changed lines |
| `timeoutSec` | `300` | a run past it counts as caught |
| `testCommand` | `""` | guessed from Makefile, package.json, Cargo.toml, go.mod, pyproject.toml, Package.swift |

The copy takes disk space and time where no clone is possible (a large `node_modules` on a non-APFS disk). Tests run on the host, outside the Bash sandbox.

### perf-delta

- `/perf <command>`: one warm-up and N measured runs; the first time saves a baseline, later runs compare with it (a baseline belongs to the command and the folder it ran in)
- `/perf base <command>`: measure and save as the baseline
- `/perf ref <git-ref> <command>`: run the ref in a temporary `git worktree` (a folder `mktemp` makes, in the same folder below the top as the session), then the working tree (dependencies not in git, such as `node_modules`, are missing there); the worktree is locked while it runs; one git cannot remove is deleted with its own registration (never `git worktree prune`, which would drop your worktrees whose folders are away), and one a run cut short left is removed by a later session start after 48 hours
- `/perf show`, `/perf clear [command]`

Time and peak memory come from `/usr/bin/time` (`-l` on macOS, `-v` on GNU). The report gives median, ±stdev, CV and range per side; a difference counts only beyond twice the larger stdev and 1%, with at least 3 runs a side (fewer is reported as too few to judge), and a side with CV over 10% is flagged unsteady. A folder missing at the ref, or a command that cannot start, is said as such.

| Option | Default | |
| --- | --- | --- |
| `runs` | `5` | at least 3 |
| `timeoutSec` | `300` | |

### port-lantern

A Bash command run in the background, or a server command (`pnpm dev`, `vite`, `uvicorn`, `rails s`…), is followed: its output file is read every 5 s for local URLs and ports (`--port`, `PORT=` in the command too), and `lsof` says whether a port listens. The status line keeps `🏮 ● :5173 · ○ :8000 停止`, one part per port; a toast says when one starts listening or stops. `/ports` opens the pane: URL (press to copy), command, pid, and the latest log lines, errors in red.

### artifact-shelf

Files a call made, with data, document, image, video, audio, patch or archive extensions: a Write's file, a Bash command's `-o`/`--output`/`>`/`tee` targets and converter outputs, and paths a tool's answer names, each checked to have changed during the call. Each is kept with its size, time, the call and the request it answered, per repository across sessions (300); credentials in the request and the command are masked as zukan does, also in items kept before this was done (written back masked at the next session start). The store holds the 16 shelves added to most recently; an older repository's shelf leaves. `/shelf [words]` filters by kind (`動画`, `video`), extension (`csv`), time (`今日`, `昨日`, `7d`) and text; the pane filters by kind, and pressing a name copies its path. Files deleted since are marked, not dropped.

### side-effect-ledger

Bash commands and tool calls that change things outside the working tree: `git push` (the undo written from what push printed: `git push --force-with-lease=main:<new> origin <old>:main`, or `--delete` for a new branch; each push of a chained command gets its own remote's refs, and `git -C dir push` counts), `gh pr|issue|release|repo …`, `gh api -X POST…`, npm/cargo/PyPI/gem publish, docker push, kubectl, helm, terraform, pulumi, cdk, vercel, netlify, fly, wrangler, firebase, gcloud, aws, `curl -X POST|PUT|PATCH|DELETE` to a non-local host, scp/rsync to a remote, MCP tools that create/update/send, and Artifact publish/delete. A failed call gets no undo, except where a part may already have applied (a push keeps the refs it moved; failed infrastructure says it may be partly applied and to check its state first). An undo names what pointed the command elsewhere (`KUBECONFIG`, `HELM_NAMESPACE`, `GH_REPO`, `kubectl --context/-n`), never a token. Dry runs (`--dry-run`, `git push -n`) and reads (`kubectl rollout status`, `terraform state list`, `wrangler pages dev`) are not recorded. Each entry keeps its outcome (failures too), how it would be undone and how hard that is; an undo never deletes what may have existed before: a close or delete (`gh pr close <url>`, `gh release delete`, `gh repo delete`, `helm uninstall`) is given only when the output says this call made it (the last URL, the release's own tag, no "already exists"; not when a second gh or helm command in the same line could have printed it), since a failure behind `| tail` or `|| true` exits 0; `gh pr close` keeps the head branch and `gh release delete` the tag; names the remote by the URL git printed when the push ran in another directory (`cd`, `git -C`, a subshell), and names a sha to force back only when the output surely belongs to that one push. In `/ledger` each is marked **確認済みにする** or **不要** once its undo has been checked; the status line shows only the session's succeeded calls whose undo is not easy and still unchecked, and clears when there are none (a plain push stays in `/ledger` alone). Credentials in a command (`Authorization` and other credential headers, `token=`, `NAME_TOKEN=`, `PGPASSWORD=`, JSON `"api_key": "…"`, known key shapes) are masked as zukan does before anything is kept. Kept per repository across sessions (300), each field held short (a label to 200 characters, an undo to 600, colour codes dropped). The store holds 4 MiB of JSON in all, so before each write the ledgers are held to 12 and to 3.5 M characters together: other repositories' ledgers leave, one with no unchecked undo of a call that did something first, then the least recently written; the current one is cut to its newest entries past 1.5 M. A path too long for a store key keeps its tail and a hash. A write refused for room (an index another version left low) builds the index again from every ledger and is tried once more.

### visual-diff

Each Claude in Chrome screenshot is kept as PNG with its URL and size (in `$TMPDIR/claude-visual-diff/<session>`, else `~/.cache/…`; both folders made private and checked to be yours and no link; removed at session end, and a killed session's folder by a later start once a day untouched; a running session touches its own every hour (again after a plugin reload), so it is kept while idle, though not across a day the machine sleeps). The URL is the last navigation's; after a click, a key or a form input, which may have left the page, it is asked of Claude in Chrome's tab listing for the tab shot, and a shot whose URL cannot be told is kept but never compared. A new one is compared with the last of the same URL and size taken before an edit (or the previous one, or a baseline set with `/vdiff base`): both scaled to 320 px with `sips` (or ImageMagick), a 32-column grid of cells that changed, the changed regions in page pixels, and the files edited in between. `/vdiff` opens the pane: both pictures side by side in the terminal (kitty graphics), the change map and the regions elsewhere. `/vdiff clear` removes the baselines.

### journey-trace

Claude in Chrome navigations, clicks, typing, keys, form fills and scrolls are recorded as steps; elements named by `find`/`read_page` keep their role and name. Expected states come from `/journey expect <text>` and from Claude through the tool `mcp__journey-trace__expect`. `/journey start [name]`, `stop`, `resume`, `clear`; `/journey md` copies a bug report (steps, expected, actual to fill in, environment), `/journey e2e` a Playwright test where coordinate-only clicks are left as TODOs. A secret is never kept: a value filled into a field named as one (password, token, OTP, PIN, security code…), text typed while such a field has the focus, and text shaped like a known key are recorded as `***`, the report saying so and the test reading `process.env.JOURNEY_SECRET_n`; where the field is not known (after Tab or Enter, a click by coordinates, a new page), text that reads as a password or a one-time code is too. In a URL, secret parameters in the query and the fragment (`token`, `signature`, `sessionId`…, `code` on a callback page), key-shaped text in the path and the user part are masked. A fill into a select or a checkbox is written as `selectOption` or `check`.

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

### kachi

When a check you broke passes after a real fix, the band above the prompt sweeps green once with a short click and settles into one row naming the check (`✔ pnpm test  green`); the Bash row that turned green keeps one dim receipt line with what the fix cost (`✔ red→green  try 3 · red for 2m41s · 3 → 0 failing`).
Nothing else is drawn, except one dim line under a check's first red of the session (`◌ kachi: pnpm test is red; a real fix rings`), so you know it is there; a turn with no red and no fix draws nothing.

Sound is on by default; `sound: quiet` halves it and `off` silences it (clips play through `afplay` on macOS; elsewhere the sweep and the receipt line carry the moment).

Try it: make a test fail, then ask Claude to fix it.

| Tier | Earned by | Sound | Motion |
| --- | --- | --- | --- |
| tick (off by default: `minTier` `tick`) | the first whole run of a check passing after code edits, or a commit on a tree a check passed after its last edit (10 min apart; a check failing after it takes the stamp down) | 60 ms tick | stamp only |
| click | red → green after 1 or 2 failed runs, under 5 min red | 140 ms click | one sweep |
| chime | 3 or more failed runs, or 5 min or more red | 380 ms, two notes | a sweep and a pulse |
| bell | 8 or more failed runs, 20 min or more red, or 10 or more failing down to 0 | 700 ms bell | two sweeps and a pulse |

The stamp leaves at the next prompt, 60 s after the turn ends, or as soon as the check it names fails again; the receipt line stays in the transcript. One clip at most per win shown, none within 20 s of the last, and a second win in the same turn only raises the stamp to a higher tier. In the terminal the sweep is a moving light; desktop, which draws no cell grid, shows the stamp alone. Nothing is sent to Claude and nothing is kept past the session.

#### What counts

- **Checks:** tests, lint, type-checks and builds as done-gate reads them, `xcodebuild test`, `swift test`, `claude plugin test`, `pnpm exec <check>` and `pnpm vitest run <file>`. Each is kept per directory: `cd web && pnpm test` and `cd api && pnpm test` are two checks, and after a `cd` the text cannot resolve (`cd "$DIR"`, `cd -`) nothing is read.
- **Piped checks** (`2>&1 | tail -20`, `| grep`, `|| true`, `; echo`), whose exit status is another command's, are read from their own output. A failure count is red (cargo's `due to N previous errors` included). A printed pass count with no failure count is green, even where a test name or a log line says FAIL. With no count, a runner's or compiler's own failure line is red: `FAIL  x.test.ts`, `FAILED t.py::x`, `--- FAIL:`, `not ok`, `error:` / `error[E0308]:` / `x.swift:3:5: error:`, make's `*** [x] Error 1`. Empty output from `tsc` or `eslint` (or a package script's header alone, when it runs only those), cargo's `Finished` line for build/check/clippy and `Build complete!` for `swift build` are green. Anything else counts for nothing and clears a red that check had, so a much later pass does not ring with a stale duration.
- **The fix:** an Edit or Write, or a Bash command whose text says what it writes (`sed -i`, `perl -pi`, a heredoc or `>` into a file, `tee`, `cp`/`mv`, `git checkout -- <path>`, `git restore`, `prettier --write`, `eslint --fix` and other fixers). In one command line only a write before the check counts for it. An edit counts for the checks whose directory holds the file, or for every check when it is outside all of them.
- **Long failures** cut short for the model are counted from their stored text or persisted output when either holds the summary; otherwise the receipt line names no count.
- **Never a win:** a re-run with no edit since the failure; a pass after editing only test files (`tests/`, `__tests__/`, Swift's and Xcode's `Tests/` and `AppTests/`, `*.test.*`, `*_test.go`, `*_spec.rb`, `test_*.py`, `PriceTests.swift`, `PriceSpec.kt`, `PriceTest.java`, and the `testPaths` globs); a pass narrower than the failure (a file, `-t`, `-k`, `--lf`, a filter: the failed scope or a broader one has to pass); a run where no tests ran; failures that are not a check failing (exit 126 or 127; the shell's own `command not found`, `No such file or directory`, `permission denied` or `Operation not permitted` line, a missing script or make target, but only when the output holds no failure count and no FAIL line; interrupted, backgrounded or timed-out runs).
- **Language:** Japanese under a ja locale (the `language` setting, else `LC_ALL`, `LC_MESSAGES`, `LANG`), English otherwise.

| Option | Default | |
| --- | --- | --- |
| `sound` | `on` | `quiet`: half the gain, no tick; `off` |
| `motion` | `sweep` | `none`: the stamp only (reduced motion) |
| `minTier` | `click` | wins below this tier draw and play nothing; `tick` adds first greens and clean commits, `chime` or `bell` keep only the bigger fixes |
| `commits` | `true` | off: commits never tick |
| `testPaths` | `""` | extra comma-separated globs that count as test files (`e2e/**,*.snap`; `*` within a directory, `**` across them, `?` one character), matched against a path's last 256 characters |

### cross-check

Needs the Codex CLI (`codex`) on `PATH`, logged in. While the repository has something to review, the band above the prompt shows `🔍 未レビュー（未コミットの変更） 3ファイル +120 −8 [ Codex でレビュー ]`: the uncommitted changes (staged, unstaged and untracked), or, when there are none, the branch against origin's default branch (else `main`). One press runs `codex exec --sandbox read-only --json --ephemeral --output-schema hooks/schema.json` with a review prompt (`codex exec review` answers in prose and ignores the schema); the band then shows the elapsed time and what Codex is doing, with 中止.

When it ends, the band shows the most severe finding and how many more (`🔍 high · m.py:4 空リストで ZeroDivisionError · ほか2件`), and a toast says how many. **Claude に直させる** puts the findings into the prompt, quoted as data, for you to send; nothing is sent by itself. **詳細** and `/codex` open the pane: each finding with 直させる (that one alone) and 却下. `/codex-review` starts a review as the button does. The status line keeps `🔍 codex 3件`.

The diff is measured again after each turn; once it changes, the findings are marked 古い and the band offers a review again. 閉じる hides the band until the diff changes. A failure says why (`codex login が必要`, `codex が見つかりません`, Codex's own error) with 再試行. Codex reads the repository and may run commands in its read-only sandbox; Codex always runs `gpt-6.1-sol` at medium reasoning effort; what it reads is sent to the model provider your Codex is set up with. Nothing is kept past the session.

An unreadable diff or untracked file is a measurement failure: the previous review is not considered current. Untracked names containing quotes or newlines, and symbolic links (including broken ones), are included in change detection. A response that does not match the review schema is a failed review with a retry, never “no findings”; a valid empty findings list still means the review found no defects. Closing a failed review's band or cancelling its retry does not restore an earlier “no findings” result; the failure remains in the status line and pane until a new review produces a valid result.

Untracked files are read from the session's working directory, including below the repository root. Their raw content changes count even when Git's clean filters or line-ending normalization would erase the difference. Tracked files still follow Git's diff; the measurement is not an atomic snapshot of all filesystem changes.

| Option | Default | |
| --- | --- | --- |
| `timeoutMin` | `15` | a review still running after this many minutes is stopped |

### ci-rehearsal

Needs [runthrough](https://github.com/simota/runthrough) on `PATH`, and Docker running unless `mode` says otherwise. While `runthrough -n <event>` plans jobs for the event on this branch (its branch and tag filters applied), the band above the prompt shows `CI 未確認 · push 3 jobs [ 走らせる ]`. When the event triggers nothing here (a `pull_request`-only repository, or `push` filtered to `main` on another branch), the band offers the first event `runthrough -l` lists that does, saying so: `CI 未確認 · pull_request 2 jobs（push では走らない）`. One press runs `runthrough push --json --no-history --no-cache-server` on the working tree, uncommitted and untracked changes included (`scope: committed` adds `--committed`); the band then shows the elapsed time, the job running and how many are done, with 止める. Without Docker the band says so and offers host で走らせる for that one run; it never switches to the host by itself.

When it ends, a pass shows `CI ✅ 3/3 1:12`; a failure shows the first failing step and how many more (`CI ❌ CI / test › Run npm test · ほか1件`), and a toast says how many. **Claude に頼む** puts each failure with its last 40 log lines into the prompt, quoted as data, for you to send; nothing is sent by itself. **詳細** and `/ci` open the pane: every job's result, each failure's log tail, 直させる (that one alone) and このジョブだけ (reruns it with `-j`). `/ci-run` starts a run as the button does. The status line keeps `CI ✅`, `CI ❌ 2` or `CI 古い`.

The tree is measured again after each turn; once it changes, the result is marked 古い and the band offers a run again. 閉じる hides the band until the tree changes. A run that ends without runthrough's summary says why (its last error line) with 再試行. runthrough reads `.secrets`, `.vars` and `.env` as it does by default and masks secrets in its logs; the mod never passes `--insecure-secrets`. In `host` mode the workflows' commands run on this machine, outside any container. Nothing is kept past the session.

A single-job rerun is labelled as a partial result on the band, status line and pane. It keeps the other known failures and offers a full run; its success does not establish that the whole workflow passes. Results from a different tree remain marked old. With `scope: committed`, planning and event selection also read HEAD, just as execution does. A failed tree measurement is shown as an error, rather than leaving an old success current; untracked names containing quotes or newlines and symbolic links are included.

An incomplete or inconsistent summary, an exit status that disagrees with it, or a failed or truncated job plan is an error. Closing that error hides the band but does not restore an earlier success as the current result. A job that runthrough formally passes through `continue-on-error` is not kept as a failure just because its earlier logs contain an error. Untracked files use their raw content and the session's working directory, as cross-check does.

| Option | Default | |
| --- | --- | --- |
| `mode` | `container` | `container` (Docker), `host` (`--host`: on this machine) or `apple-container` (`--engine container`, macOS 26+) |
| `scope` | `worktree` | `committed`: run the HEAD commit as a push would (`--committed`) |
| `event` | `push` | the event that triggers the workflows; another listed one is used when it triggers nothing on this branch |
| `auto` | `off` | `turn-end`: run when Claude's turn ends with the tree changed since the last result |
| `timeoutMin` | `20` | a run still going after this many minutes is stopped |

### stack-dock

Needs [devrouter](https://github.com/simota/devrouter) on `PATH` and Docker. At session start, after a turn that edited `devrouter.yaml`, a compose file, `package.json` or `pnpm-workspace.yaml`, and after any `devrouter` or `docker compose` command Claude runs, the mod runs `devrouter doctor` on the repository root (read-only) and reads `~/.devrouter/registry.json`. The band above the prompt then shows one state: `devrouter · app 2 services [ 起動 ]` when the stack is ready but stopped; `devrouter · 未設定（compose あり）` with init で生成 (`devrouter init`, never `--force`; only when a compose file exists) and Claude に作らせる (a prompt, after devrouter's `prompts/generate-config.md`, to write `devrouter.yaml` and `docker-compose.devrouter.yml`); `devrouter ❌ doctor: …` for another doctor error; or `Docker が動いていません` with 再確認. Nothing is drawn without devrouter, or when the root has no devrouter config, compose file or workspace.

起動 runs `devrouter up <root>` (再ビルドして起動 in the pane adds `--build`) and streams it: the band shows the elapsed time and compose's last line, with 止める. A failure shows its `error:` line; **Claude に頼む** puts it, doctor's findings and the output's last lines into the prompt, quoted as data, for you to send.

Live progress is assembled separately for stdout and stderr, then masked before it is stored or shortened, using the same credential patterns as the retained logs. A stack is ready to start automatically only when every container is absent, newly created, or exited with status 0. Other non-running states, including `dead`, `restarting` and `paused`, are shown as degraded even when no service is running. If the registry, container list or doctor result cannot be read reliably, the mod shows a diagnostic and offers a recheck; an unknown state does not trigger automatic startup. Once a reliable check confirms recovery or a clean stop, a pending service-down notification is cleared; a failed `up` still needs its own recovery evidence.

Truncated doctor output blocks automatic startup even if the remaining lines look valid. A truncated container list is an unknown measurement and cannot establish recovery or a clean stop. When the registry is used to clear a failed `up`, the complete measurement must show a successful start strictly after the failure. Its second-precision timestamp cannot prove recovery when it is in the same second as the failure.

While the stack is up, every `pollSec` seconds the mod checks each service's container (`docker compose ps`) and URL through Traefik. A running stack draws no band, only `⛵ app 2/2` in the status line, with toasts when it starts, stops or a service goes down. A service that exited, or answers 5xx or not at all, shows as `devrouter ❌ api exited (1) · ほか1件` with Claude に頼む (its last 40 log lines, credentials masked as zukan does). A certificate the host does not trust and Traefik's own 404 (no router) are shown in yellow in the pane, not taken for down. `/stack` opens the pane: each service with its URL (press to copy), container state, HTTP status and recent log lines, 開く (`devrouter open`) and 直させる; 再起動, 再ビルドして起動, 停止 (`devrouter down`) and doctor. `/stack-up` and `/stack-down` act as the buttons do. 閉じる hides the band until the state changes.

Claude can call the tool `mcp__stack-dock__status` for each service's URL, container state and HTTP status instead of guessing a localhost port. With `feed` on, a service going down or `devrouter up` failing is attached once to the next prompt you type at an idle prompt (not to slash commands, hidden prompts or plugin prompts), marked as data. The mod keeps nothing past the session: devrouter's registry and Docker hold the truth.

| Option | Default | |
| --- | --- | --- |
| `auto` | `off` | `session-start`: run `devrouter up` when a session starts and the stack is ready but stopped |
| `stopOnExit` | `false` | run `devrouter down` when the session ends |
| `feed` | `true` | attach a service going down, or a failed up, to the next prompt |
| `pollSec` | `10` | how often a running stack is checked (5–60) |

## Develop

```
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
claude --plugin-dir mods/<mod>
scripts/check-copies.sh
```

Mods share no code, so a few files are copies of another mod's (`mods/zukan/hooks/shell.ts`, `mods/hit-rate/hooks/shell.ts` and `mods/kachi/hooks/shell.ts` are done-gate's; `mask.ts` in side-effect-ledger, artifact-shelf, browser-cam and stack-dock is zukan's; ci-rehearsal's `fingerprint.ts` is cross-check's). `scripts/check-copies.sh` fails when a copy drifts.

## License

MIT — see [LICENSE](LICENSE).
