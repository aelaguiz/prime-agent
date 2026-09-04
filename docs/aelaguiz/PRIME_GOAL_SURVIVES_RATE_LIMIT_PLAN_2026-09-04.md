# Goals survive rate limits and resume on account rotation (plan, 2026-09-04)

## Problem

`aim prime resume <id> --rotate` on a rate-limited thread "loses the goal". It does not: the 429 turn ends with `stopReason: "error"`, and `_finishGoalForTerminalAssistantMessage` (`packages/coding-agent/src/core/agent-session.ts:1991-2005`) treats every error as terminal, writing the goal as `status: "error"` seconds before the rotate runs. `/goal resume` (`:1952-1960`) only re-arms `paused` or `budget_limited`, so the only way back is retyping `/goal <objective>`, which starts a new goal with `continuationsUsed` reset. Every rotated goal session in `~/.prime/agent/sessions` shows this exact sequence (goal → error at the 429 timestamp, `aimgr_credential_binding_v1` afterwards, then a fresh goal with the same objective).

## Outcome wanted

Rotate, and the goal picks up where it was. No `/goal` retyping, no thinking.

## Design (about 40 lines, no new subsystems)

1. **Transient provider failures pause the goal instead of ending it.** In `_finishGoalForTerminalAssistantMessage`, if the error is transient (structured `provider_stream_failure` kind `usage_limit`, or the message matches rate limit / 429 / overloaded / connection / timeout / fetch failed / websocket / "requires reauthentication"), call `_pauseGoal("Paused: <error>")` instead of `_finishGoalWithError`. Real failures (auth, invalid request, refusal, anything else) still end the goal as today.
2. **`/goal resume` also accepts `error`.** A user typing resume on an errored goal means resume. Covers goals that errored under the old code.
3. **A credential handoff resumes the goal.** `AgentSessionRuntime.handoffAimCredential` (`agent-session-runtime.ts:343`) calls `session.resumeGoalAfterCredentialHandoff()` once the handoff succeeds. That method re-arms a goal that is `paused` by rule 1 or `error` with a transient `lastError`, and queues one continuation. A goal paused by the user (`/goal pause`) is left alone.

Nothing changes for goals that complete, are cleared, or hit their budget. No new records, no new commands, no flags.

## Steps

1. Implement 1-3 in `agent-session.ts` and `agent-session-runtime.ts`.
2. Update the two tests that pin the old semantics (`test/suite/agent-session-goal.test.ts:597` "does not resume an errored goal", `:782` "marks the goal as errored on terminal provider errors") to use a permanent error, and add three tests: 429 pauses with the objective intact; `/goal resume` from error works; handoff resumes a rate-limit pause and leaves a user pause alone. Run only that file plus the runtime events test.
3. Build, pack, install into the current prefix (`~/.prime/installs/main-c8bc030`, the path the running supervisor spawns workers from), verify the bundle id changed. **No supervisor restart**: the fix lives in workers and TUIs, and the supervisor spawns new workers from that path. Already-resident workers keep the old code until they cycle; that is a separate, user-approved step.
4. Push to `origin/main`; cherry-pick onto `home/discovery-hotfix` for amir-server (runs from source, no install step).

## Not doing

- No retry/backoff loop for 429s inside the goal engine.
- No automatic account rotation from inside Prime for Anthropic (Codex already has `advanceAimCredential`).
- No worker cycling without being asked.
