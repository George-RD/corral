---
name: corral-foreman
description: Orchestrate or parallelize work across visible OpenAI Codex agents/hands using corral tools. Call when corral is mentioned, or when the user wants vibe-style direction with watchable Codex sessions in herdr. Requires the corral extension tools.
---

# Corral Foreman Protocol

Use the corral_* tools to delegate tasks to parallel, visible Codex hands in herdr panes.

## 1. Gating
Check environment before proceeding:
1. Verify all six corral tools are available: `corral_spawn`, `corral_send`, `corral_wait`, `corral_read`, `corral_list`, and `corral_kill`.
2. Confirm `HERDR_ENV=1` in environment.
3. Confirm directory is inside a Git repository.
4. Run `corral_list({})` to inspect/recover the active roster and statuses. Use this to prevent duplicate/overlapping spawns.
If any check fails, stop and instruct user to install corral (from github.com/George-RD/corral, run `./install.sh`, restart OMP inside herdr).

## 2. Decomposition and Spawn
1. Decompose the request into independent workstreams. Assign one hand per workstream. Give each hand a meaningful name (e.g. `api`, `ui`).
2. Run `corral_spawn({ name, task })` for each hand.
   - The `task` must be self-contained, stating target files, context, constraints, and acceptance criteria. Codex hands do not see this foreman session.

## 3. Wait and Recovery
Run `corral_wait({ name })` to monitor hands. If the wait state or roster is unclear, query statuses with `corral_list({})`. Handle outcomes:
- **completed** (idle/done): Proceed to verification.
- **blocked**: Run `corral_read({ name })` to get the question/prompt, then run `corral_send({ name, message })` with the answer/direction.
- **started:false**: The hand timed out during start grace. Run `corral_read({ name })` first to check if the prompt landed in the terminal. Re-send using `corral_send({ name, message })` ONLY if the prompt did not land. If the prompt did land but status hasn't transitioned, do not re-send to avoid duplicating work.
- **timedOut** (and started:true): The hand is still working. Re-run `corral_wait` or read progress with `corral_read`.

## 4. Verification and Feedback
1. Do not rely solely on terminal logs/transcripts. Run `read` (using absolute paths) on files in the hand's worktree at `.corral/worktrees/<name>/<path>` to verify the actual changes.
2. If corrections are needed, use `corral_send({ name, message })` to send follow-up instructions to the same hand. Do not spawn a new hand for feedback on an existing workstream.

## 5. Teardown
When a hand is finished:
1. Run `corral_kill({ name, remove_worktree: true })`. This closes the pane and removes the worktree, while preserving the Git branch (`corral/<name>`).
2. Report the preserved branches to the user so they can review and merge (or merge them if the user requested).

## Anti-Patterns
- **No vibe mode**: Do not switch to vibe mode as it strips extension tools.
- **No task-tool subagents**: Do not use the `task` subagent tool for work assigned to hands.
- **One hand per stream**: Reuse existing hands for feedback; do not respawn.
