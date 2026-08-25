# Prime Agent Usage Mining — worker2

## 0. Ranked remote operations by real-world frequency

Evidence base: 506 user messages across 55 sampled sessions (40 recent + 15 older) of 729 total;
10-30 concurrent sessions/day at peak; frequencies from §1 taxonomy.

| Rank | Remote operation | Real-world frequency proxy | Notes |
|---|---|---|---|
| 1 | `fleet_status` — one table: per-session name, working/waiting/stalled/rate-limited, staleness, pending question, artifacts, PRs | 27+ explicit status pings; implicit before nearly every other action; "wya" broadcast to 3 sessions in 4 min | The core product. Must be evidence-based, not agent self-report |
| 2 | `send_message` / steer a named session (free text) | ~56% of all messages are mid-thread directives | Everything routes through this; needs interrupt-preemption for "stop" |
| 3 | `nudge/continue` (canned resume, incl. rate-limit resume) | 14 one-word nudges + 11 rate-limit resumes + gap-then-nudge in 20/51 sessions | Prime candidate for automation with notify |
| 4 | `pending_questions` + short reply (approve/deny/choose) | dozens of approval one-liners; "whats the question?" pain | He is the merge/permission authority; decisions block fleets |
| 5 | `start_session` from reference (issue #, PR #, old thread id) with "ramp up" template | 19 kickoffs in sample; standard daily act | Include takeover-of-old-thread variant (8 occurrences) |
| 6 | `recover_all` — bulk canned interrupted-work reconcile after daemon restart | 6 sessions hit; sent 3-at-once manually today | Pairs with daemon-restart detection |
| 7 | `paste_review` — deliver external (GPT-Pro) verdict + triage policy to a session | 34+ occurrences, near-daily per active PR | His highest-leverage quality loop |
| 8 | `heartbeat_ctl` — attach/clear/list heartbeats per session + fleet-wide GC | 9 explicit commands; "20 paused heartbeats" mess | Fleet-wide list is missing today |
| 9 | `notify_merged` / PR-event push to owning session | 8+ "X is merged" messages | Could be evented from GitHub instead of typed |
| 10 | `get_artifact` — plan-doc paths, docs, cf-share links | 11 path requests + share asks | Full absolute paths (he added an agents.md rule about it) |
| 11 | `abort/interrupt` — stop, close PR, kill scope | ~10 hard stops | Must take effect mid-turn, not after |
| 12 | `restart_session` / kernel-state revive awareness | "I had to restart prime agent", "kernel froze? its restored" | Surface kernel/daemon health per session |

Cross-cutting requirements: multi-machine (mac-studio + 2 M3 laptops over Tailscale, §3); voice-to-text
tolerant input (many messages are dictated with typos); one-to-many broadcast (same text to N sessions);
collision detection (two sessions grabbing the same PR, §4).

## 1. USER message taxonomy (55 sessions sampled: 40 most-recent + 15 random older; 506 top-level user messages)

All 55 sampled transcripts were rlmDepth=0 (top-level, Amir-facing). Child/worker transcripts live under
`session-artifacts/<id>/sub-*/`. Message classification (heuristic, hand-verified on samples):

| Category | Count | ~% | Notes |
|---|---|---|---|
| Task/direction (mid-thread work orders) | ~283 | 56% | "put a full plan together", "implement milestone one only", clarifying Qs |
| — of which: pasted external review verdicts (long) | 19 | | ChatGPT-Pro "## Verdict" blocks pasted inline with a directive |
| — of which: plan requests / plan management | 46 | | "put together full implementation plan", "update the plan" |
| — of which: PR-related direction | 30 | | "get the PR updated", "stack the PRs and DO NOT ALLOW SCOPE CREEP" |
| — of which: delegation dispatch | 13 | | "dispatch to Opus 5 X-High", "/skill:conductor", "farm it out to subagents" |
| External review paste + "do you agree?" | 34 | 7% | THE signature workflow: paste GPT-5.6-Pro PR/plan review, agent triages it |
| Status inquiry | 27 | 5% | "where we at", "wya", "still going?", "you stuck?", "did this finish?" |
| Steering / correction (often profane, blunt) | 26 | 5% | "Stop implementing. I never said implement.", "that's not what I want" |
| Merge/CI coordination | 22 | 4% | "merged 33 you do 23", "CI is failing", "37 is merged" |
| New-task kickoff "ramp up on X" | 19 | 4% | canonical session opener: issue #, PR #, or prior prime-agent thread id |
| One-word approval/nudge | 14 | 3% | "go", "continue", "do it", "yes" |
| Rate-limit resume | 11 | 2% | "we got rate limited pick it back up" — very frequent recovery act |
| Artifact path request | 11 | 2% | "show me full path on disk to the plan" (so he can open/share it) |
| Heartbeat management | 6+3 | 2% | "keep a heartbeat on this", "clear out the 20 paused heartbeats"; 3x canned interrupted-work recovery prompt |
| Scheduled AIM routines (automated, via aimgr) | 11 | 2% | "AIM routine binding check...AIM_ROUTINE_PIN_OK" + morning-report / community-sweep routine bodies |
| Short other / misc | ~38 | 8% | typo fixups ("*conflicts"), "sent note it that I sent that", context notes |

Slash-command usage (embedded in messages): `/skill:startup-pragmatism` x12 (dominant — used as an
overbuild filter on review feedback), `/skill:conductor` x2, `/skill:agents-md-authoring` x2,
`/skill:gh-issue-filing` x2, `/skill:skill-authoring` x2, `/cf-share` + `/skill:cf-share` x4,
`/skill:bottom-up-diagnostic` x1. Bare slash-command-as-whole-message is rare (1); he references
skills inline inside prose directives.

### Verbatim examples — status inquiries
- "where we at" (appears 6+ times, sometimes twice in a row within a minute)
- "wya" (sent to 3 different sessions within 4 minutes — manual fleet polling)
- "still going?" / "are they still running?" / "we still going?"
- "you stuck?"
- "did this finish?"
- "are you sure anything is going?"
- "You know go look and make sure you're actually doing something. Don't just check your status."
- "what is going on you've been doing nothing for like a long time and I have feedback for the PRs but I ..."

### Verbatim examples — steering / correction
- "just stack the PRs and DO NOT ALLOW SCOPE CREEP"
- "Stop implementing. I never said implement."
- "Wait what the fuck? Okay why do we need locking? ... I want simple. This is a totally hypothetical concern."
- "The fuck are you talking about? Dude, use native Prime agent [Sol/xhigh] agents. Don't fucking dispat..."
- "WHY DID YOU MERGE THIS AUTOMATICALLY YOU CANNOT MERGE THINGS WITHOUT PERMISSION EVER GET THAT OFF MA[IN]"
- "Please don't get in a PR agent death loop. It's not your boss."
- "Start over. This is garbage. Build a new plan that isn't insanely overbuilt..."
- "It's fine. Just stay on the scope that I put you on."
- "Dude, stop stealing my focus." (an agent stole macOS window focus)
- "that wasn't for you sorry I put it in wrong window. We still going?" (wrong-session sends happen)

### Verbatim examples — restart / recovery
- "we got rate limited pick it back up" / "got rate limited finish this" / "rate limited again, pick it back up"
- "check status I had to restart prim eagent it may be lying don't trust just a cursory look"
- "i assume kernel froze? its restored"
- "look slike you were locked up. Don't lock up foreground please. Pick it back up"
- "think you locked up"
- "switched to fable 5 because opus keeps messing this up. Please finish this out..."
- "just try again on a heartbeat when it clears up"
- "go, i'm going to bed finish and get the PR up"

## 2. Session shapes (51 active of 55 sampled)

- **Duration**: median ~16h wall-clock; p75 ~29h; 17/51 (33%) ran >24h; 4 sessions ran 3-5+ days
  (e.g. `1a0d16` 134h, `b342b8` 108h, `d28999` 86h, `19cbc6` 85h). 28/51 (55%) span multiple calendar days.
  Sessions are long-lived project threads, resumed over days — not one-shot chats.
- **Turns**: median 4 user messages/session, p75 = 10, p90 = 26, max 76 (`ec8e37`, a 2-day puzzle-solver
  research thread). Assistant/tool events dwarf user events ~50:1.
- **Concurrency is the headline**: on 2026-08-24 Amir typed into **30 distinct sessions**; on 08-25 (partial
  day) 23. He runs a fleet of 10-30 parallel sessions and round-robins attention. Same message pasted to
  2-3 sessions within a minute is common ("wya" x3 in 4 min; identical kickoffs to `30986f`+`cdde6f`;
  identical release-blocker prompts to 4 sessions).
- **Child-agent (rlm) usage**: 33/51 (65%) of active sessions have `child_usage_attributed` events —
  heavy sub-agent delegation (up to 5,789 attribution events in one session). Assistant `rlm(` spawn calls
  visible in the same 33.
- **Heartbeat usage**: 19/51 (37%) sessions show heartbeat activity (`rlm_heartbeat` in assistant turns);
  user explicitly commands heartbeats in ~6 messages. One complaint: "can you clear out the 20 paused
  heartbeats" — heartbeats accumulate and need remote GC.
- **Goal usage**: goal-marker hits are rare in this sample; heartbeats + long threads are the continuation
  mechanism of choice.
- **Stuck evidence**: 20/51 sessions have >8h gaps between consecutive user messages followed by a nudge.
  Typical resume messages after a gap: "continue", "where we at", "we got rate limited pick it back up",
  "look slike you were locked up ... Pick it back up". At least 3 sessions received the canned
  "Continue from the interrupted work exactly where it stopped. Reconcile the surviving repo/worktree,
  in-flight child or subagent, heartbeat, and watcher state first..." recovery prompt — 6/729 sessions
  contain it overall (sent in bulk at 18:03 on 08-23 to 3 sessions at once = a daemon-restart recovery sweep).
- **Scheduled sessions**: aimgr-driven routines (morning-report at 11:00Z, community-sweep at 18:09/22:00Z)
  appear as fresh sessions opened by an "AIM routine binding check" pin + the routine markdown body; Amir
  then interacts with the results ("did our morning dbts work?", "1. Yes 2. Yes Post both").
- **Repos**: overwhelmingly `psagentspace` (poker-skill ops/agent workspace); also `agentspace` (cjdev
  marketplace), `logan` (personal legal matter), `aimgr`, `arch_skill`. One agent manages both code repos
  and non-code life workflows.

## 3. Cross-machine evidence

Across all 729 transcripts (filename-level grep): `amirs-mac-studio` appears in **174 sessions**,
`agents@` in 166, `tailscale` in 169, `ssh ` in 229, M3-machine names in 79, "macbook" in 12.

- Primary remote target: **`agents@amirs-mac-studio`** (221 occurrences in just the 40 most recent
  transcripts) — a Mac Studio reached over Tailscale where agent workloads ("cjagents", DB access,
  builds) run. Verbatim user instruction: *"you can also check agents@amirs-mac-studio the cjagents
  stuff talks to db im fairly certain"*.
- Secondary machines: `amirs-m3-max-new`, `amirs-m3-36gb` (MacBook-class laptops on the tailnet).
  The `$amir-publish` skill confirms a cluster: publish flow SSHes to known hosts, skips current
  machine, pulls repo, installs — Amir maintains a multi-machine skill/agent fleet.
- Implication for MCP: sessions are local to ONE machine's `~/.prime`, but Amir works across at least
  3 machines. A remote-control MCP needs per-host fleet visibility (which host runs which sessions),
  not just one daemon. Cross-machine reach today is manual ssh inside sessions.

## 4. Stuck / takeover behavior

When a session stalls or wanders, observed escalation ladder (from transcripts):

1. **Ping it**: "still going?", "wya", "you stuck?", "are you sure anything is going?" — often to
   several sessions in a burst.
2. **Nudge it**: bare "continue" (sometimes 2-3x over hours), "can you please see this through rather
   than halting", "yeah is it happening? Just finish dude don't fucking stop".
3. **Diagnose common stall causes by hand**: provider rate limits ("we got rate limited pick it back
   up" — 11 occurrences in sample, the single most common recovery), frozen IPython kernel ("i assume
   kernel froze? its restored"), foreground lockups ("look slike you were locked up. Don't lock up
   foreground please"), daemon restarts ("check status I had to restart prim eagent it may be lying
   don't trust just a cursory look").
4. **Attach a heartbeat as insurance**: "Just keep a heartbeat going so you don't fucking just block
   here randomly for no reason. See it through.", "keep a heartbeat on it so you don't just dorp this",
   "just try again on a heartbeat when it clears up" (rate-limit-aware retry).
5. **Bulk recovery after daemon restart**: canned prompt "Continue from the interrupted work exactly
   where it stopped. Reconcile the surviving repo/worktree, in-flight child or subagent, heartbeat,
   and watcher state first; resume or replace only work that ac[tually stopped]" — sent to 3 sessions
   simultaneously (08-23 18:03), i.e. he already scripts/one-to-many pastes recovery.
6. **Takeover via new session**: start a FRESH session and point it at the old thread id:
   "ramp up on prime agent thread 01a03525-... and figure out what it was doign and where it was in
   the process"; "ramp up on ... the prime agent session 01a01ae2-... It got completely out of scope.
   I want you to put a full fix plan to rip o[ut...]". 8 such takeover/resume-by-reference messages
   in the 55-session sample. Old-session forensics + takeover is an established pattern.
7. **Model swap on repeated failure**: "switched to fable 5 because opus keeps messing this up.
   Please finish this out."
8. **Scope abort**: "close that PR entirely, remove the M2 plans from disk", "Start over. This is
   garbage.", "Stop implementing. I never said implement."

Cross-session interference is real: "an unrelated agent got working on 4419 by accident make sure its
what you think it is" / "why are you working on 4419, I'm confused weren't you working on a stack of
4 PRs?" — fleet-level awareness of who-owns-what is currently in Amir's head only.

## 5. Fleet-status fields a remote "how's everything going?" tool should return

Ground truth available today per session (from transcript/daemon state):
`session_state` ({active|archived}), `agent_status` events (taskState — observed only `needs_input`
with empty summary; emitted every ~20s as a keepalive, so timestamps ARE a liveness signal),
`session_info.name` (auto-title), cwd/repo/branch, model+thinking level, rlm child ledger,
heartbeat registry, session-leases.

Fields per session (ranked by how directly they answer Amir's actual questions):
1. **name/auto-title + cwd/repo/branch** — he addresses sessions by topic ("the 4409 one", "the puzzle one").
2. **state: working | idle-awaiting-user | blocked | stalled | rate-limited | kernel-dead** — his #1
   question is "still going?". Must distinguish "actively running tools" from "sitting at needs_input"
   from "wedged". Include `last_activity_ts` + `last_tool_call_ts` (staleness in minutes).
3. **waiting_on_user: bool + the pending question** — huge share of stalls are the agent asking a
   question he never saw. "whats the question?" / "What's the question? This is a wall of text. Just
   tell me what the question is." A one-line pending-question field would kill this pain.
4. **current objective + last completed step** — his resume prompts always ask "figure out where we
   were in the process, and whats next".
5. **artifact pointers**: plan-doc full path on disk (he asks "show me full path on disk" 11+ times),
   open PR numbers/URLs + their CI status + unresolved review-comment count, GH issue being worked.
6. **children/heartbeats**: live rlm children (name, task, state), active+paused heartbeat count
   ("clear out the 20 paused heartbeats"), goal state if any.
7. **provider health**: rate-limited? since when? auto-resume armed? (11/506 messages are rate-limit
   resumes he types manually today).
8. **blocked_reason** when known: awaiting merge/permission (he holds merge authority: "You can't
   merge the PR anyway. Just get the fucking PR ready. I will decide"), awaiting external review,
   awaiting CI.
9. **host/machine** — multi-machine fleet (mac-studio + M3s), see §3.
10. **scope fingerprint** — which issue/PR numbers the session believes it owns, to catch
    cross-session collisions ("an unrelated agent got working on 4419 by accident").

## 6. Top repeated actions — gold to expose remotely

1. **Fleet status poll** — "wya"/"where we at" broadcast. Today: manual paste into N windows. Remote:
   one call returning §5 table for all sessions on all machines.
2. **Nudge/continue** — bare "continue", "go", "keep going" to a named session. Cheapest, most
   frequent unblock (14 one-worders + many longer variants).
3. **Rate-limit resume** — "we got rate limited pick it back up". Should be a one-tap (or automatic
   with notify) remote op; he types it ~daily per session.
4. **Bulk interrupted-work recovery** — the canned reconcile prompt sent to every session after a
   daemon restart. Perfect candidate for a single `recover_all` op.
5. **New session kickoff from a reference** — "ramp up on issue/PR/thread <id> ... figure out where
   we were ... then <plan|fix|implement>". This is his standard session-birth template, including
   takeover of a stuck/derailed session by old-thread id.
6. **Paste external review + triage** — paste GPT-Pro "## Verdict" block with directive "take what
   you agree with, decline the rest on the PR, do NOT scope creep". 34+ occurrences. Remote op:
   send-review-to-session(text, policy=startup-pragmatism).
7. **Answer the pending question / approve a decision** — "1. Yes 2. Yes Post both", "fine post it",
   "you have permission to apply the user-facing change label". Needs the pending-question surfaced
   remotely + short reply channel.
8. **Merge notifications inbound** — "merged 33 you do 23", "37 is merged", "466 is merged you can do
   this now". He merges on GitHub (often from phone?), then tells the session. Remote op: notify
   session of merge / or session subscribes to PR merge events.
9. **Heartbeat management** — attach ("keep a heartbeat on this"), clear ("clear out the 20 paused
   heartbeats"), retry-on-clear ("just try again on a heartbeat when it clears up").
10. **Artifact fetch** — "show me full path on disk to the plan/doc" and "/cf-share this" (make a
    shareable link). Remote op: list/fetch session artifacts, one-tap cf-share.
11. **Scope police / abort** — "stop", "close that PR entirely", "Start over. This is garbage.",
    "get it off of main now". Remote op: interrupt + steer text, with immediate effect (interrupts
    must preempt a running turn).
12. **Status-of-status skepticism** — "it may be lying don't trust just a cursory look", "Don't just
    check your status." Any remote status surface must be evidence-backed (real process/tool activity,
    not the agent's self-report).

