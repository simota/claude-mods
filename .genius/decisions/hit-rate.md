```record
date: 2026-10-15
status: open
default: fix F1–F5 from .agents/quality/findings.md, wire the 13 new detectors (assertion-guard, negative-space, trust-label, zukan, pr-lamp…) into loopback's Sources, and keep adding detectors in the house pattern — each one a heuristic judged by a hand review before it ships
constraint: nobody knows any detector's precision. Since loopback, a finding no longer costs only attention — it steers Claude without the person's veto (loopback.md's own price). 13 detectors shipped on 2026-10-15; the only precision signal is a manual review (findings.md) that found false negatives/positives in 3 of them (F3, F4, F1) from synthetic inputs. Review time grows with every mod, the mod count does not wait for it. Relaxing it (each finding known right or wrong) makes the default sufficient: feed the right ones, drop the rest — so it binds.
flip: row 6 (invariant catalogue), time of judgement — a finding's life does not end when it is shown or fed back; a `hit-rate` mod gives each finding a later verdict from what the session did next, and keeps a per-detector, per-rule precision. Verdict rules by observable outcome: done-gate unverified → TP if the next check fails, FP if it passes first try; assertion-guard → TP if the weakening edit is reverted or the person objects, FP if it stands and the suite still catches a seeded mutant (mutation-tap); self-audit → TP if the rule does not recur after being fed (loopback already counts it); zukan recall → TP if the suggested fix is the one applied; trust-label → TP only when the person confirms. Undecidable findings stay `unknown`, never counted. loopback reads the table and feeds only rules whose precision ≥ a threshold with n ≥ 20; `/hit-rate` lists every detector rule with TP/FP/unknown and n.
price: verdicts are proxies, and a wrong proxy rule gives a confident wrong precision — which now gates what Claude sees, so a good detector can be muted by a bad verdict rule. The verdict rules become a second heuristic layer that itself needs review (complexity moves from each detector to hit-rate, surfacing as "why did loopback stop feeding X"). Each detector's state contract becomes load-bearing: a reshaped type breaks the scoring (caught at type check, as loopback's Sources is). Storage across sessions (F5's lost-write race applies; must use the re-read-and-merge idiom).
refute_by: after 30 days with hit-rate on, (a) more than half of all findings stay `unknown` — the outcomes cannot judge them, so the table measures nothing; or (b) a hand review of 20 random verdicts disagrees with the mod's verdict on more than 4; or (c) gating loopback by precision does not lower the rate at which the person reverts/contradicts a loopback-driven change (loopback.md refute_by (b)) compared with the ungated month
refute_cmd: none — the counts live in the mod's $.store, readable only in a session via `/hit-rate` (prints `unknown 率` and per-rule n); (b) and (c) are judged by the person
refute_when: exit-nonzero
evaluate_on: 2026-11-15
tier: reusable
owner: simota (accepted 2026-10-15 by asking for the implementation; proposed by Claude via /genius)
```

## Fallback

Turn hit-rate off: loopback falls back to feeding every finding as it does today, and every detector keeps drawing its own band — hit-rate only reads their state and writes its own table. What does not retreat for free: a detector retired or a threshold tuned because of the table.

## Candidates not taken

- row 4, when the work happens — replay past transcripts (`~/.claude/projects/*.jsonl`) through each detector's pure module offline: gives fire rates before shipping at zero runtime cost, but no verdicts (true/false still needs a judge) and it is a dev script, not a mod; the natural second step once hit-rate's verdict rules exist, to score them on history
- row 1, representation — replace heuristics with execution: a shadow runner that runs the repo's checks in a worktree after each burst of edits; ground truth, but only for the "is the code right" family, duplicates checks Claude already runs, and inherits F2's isolation problem
- row 3, boundary — one finding bus and one band for all 30 mods: struck, it is the default refactored (no new measurement, same unknown precision)
- another detector (mod #31) — struck as the default itself

## Log

- 2026-10-15 — proposed; not implemented. "最強" was undefined; taken as "raises how often the session's result is right per unit of the person's attention", since loopback made detector precision the term that decides it. Next: the person accepts or rejects; if accepted, build `mods/hit-rate` reading done-gate, assertion-guard, self-audit and zukan first (the ones with observable outcomes), off by default, then gate loopback on it.
- 2026-10-15 — re-run of /genius 最強のmods: same default, same binding constraint (no detector has a known precision). Nothing shipped since the proposal changes it; prompt-coach going on by default (8de0037) adds one more unscored source. Proposal stands unchanged — no second record written.
- 2026-10-15 — implemented as mods/hit-rate 0.1.0 (off by default; minN 20, threshold 0.5) and loopback 0.2.0 (skips rules in hit-rate's `muted`; sandbox-lens never muted). Diverged from the flip as written: (1) assertion-guard's fp is "the person marked it checked and it still stands a whole turn later", not the mutation-tap seeded-mutant test — that needs a /mutate run per finding; (2) self-audit is scored on every audited reply, not only on rules loopback fed, so a muted rule keeps being scored and can come back instead of freezing at the count that muted it; (3) trust-label is not scored (needs a person's confirmation channel; not built).
