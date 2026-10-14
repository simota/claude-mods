```record
date: 2026-10-14
status: open
default: a 14th observer mod in the house pattern — detect something in the session, draw it as a band, pane or toast for the person (as self-audit, done-gate's unverified band, sandbox-lens and context-meter do)
constraint: the correction loop runs through the person. Every finding a mod detects only changes Claude's behaviour if the person reads the band and types a correction, costing a turn and attention; relaxing it (corrections free and instant) makes another observer mod sufficient, so it binds. Bands already stack from five mods.
flip: row 3 — boundary. Findings go to the model, not the person: a `loopback` mod collects the open findings other mods hold (self-audit violations, done-gate's unverified edits, sandbox-lens denials, open #TODO(agent)) and attaches them as `context` to the person's next prompt via prompt.submit (the channel context-diet's tests already exercise). The person sees one line saying what was fed back; detectors become actuators without each learning to talk to the model.
price: the person loses the veto that reading the band gave them — a false-positive finding now steers Claude silently, surfacing as an unwanted change in a later turn. Every prompt carries extra input tokens (and a prompt-cache miss when the attached set changes). Detector precision, which only cost attention before, now costs behaviour.
refute_by: with loopback on for a month, (a) a self-audit rule flagged on reply N is flagged again on reply N+1 in at least half of the cases, i.e. feeding it back changed nothing; or (b) the person reverts or contradicts a loopback-driven change in more than 1 of 10 sessions where loopback fired
refute_cmd: none — (a) is counted in the mod's $.store, which no shell command can read; `/loopback` in a session prints it as `self-audit 再発率: repeated/fed`. (b) is judged by the person
refute_when: exit-nonzero
evaluate_on: 2026-11-14
tier: reusable
owner: simota (accepted 2026-10-14 by asking for the implementation; proposed by Claude via /genius)
```

## Fallback

Turn loopback off: every detector still draws its own band, unchanged, because loopback only reads their state. Retreat costs one `/plugin configure`; what does not retreat for free is any later mod written to publish findings for loopback instead of drawing a band.

## Candidates not taken

- row 6, time of binding — audit the reply before it is shown: no hook holds an assistant reply before display (session.append fires as it is stored), so it cannot be built on this API
- row 5, ownership of state — promote findings that recur across sessions into a per-project rule file read at session start: slower loop (next session, not next turn) and the rules go stale; worth revisiting once loopback logs history
- row 2, unit — one debrief per session instead of a check per turn: cheaper, but the correction arrives after the work it was about
- row 8, removal — drop the bands and show nothing: removes the person's only view without moving the finding anywhere useful; struck as the default minus a feature

## Log

- 2026-10-14 — proposed; not implemented. Next: the person accepts or rejects the flip; if accepted, build `mods/loopback` with a finding log so refute_cmd can become executable.
- 2026-10-14 — implemented as mods/loopback 0.1.0, off by default. Diverged from the flip as written: todo-agent's open items are not fed — they are a backlog, not findings, and feeding them would invite unasked work. Measurement (a) lives in the mod's store, read with /loopback.
