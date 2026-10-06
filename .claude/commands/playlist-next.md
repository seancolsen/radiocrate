---
description: Implement the next phase of the playlists feature
argument-hint: "[phase number; defaults to the first phase not marked done]"
---

You are implementing **one phase** of the playlists feature described in
`specs/2026-10-playlists/specs.md`. You have no memory of earlier phases. The
spec document and git history are the only handoff, so read them carefully and
leave them accurate for the next session.

Requested phase: `$ARGUMENTS` (if empty, pick the phase as described in step 2).

## 1. Orient

- Read `CLAUDE.md`. Its validation rules apply: never run `cargo build`, run
  cargo with one `-p` per invocation, and never run the workspace-wide
  `cargo test`.
- Read the spec document's **Status**, **Starting a phase**, **Definition of
  done**, all of **Implementation notes**, and your phase.
- Read every earlier phase's **As built** note. They override the plan text
  wherever the two disagree.
- Read the **Specification** sections your phase lists (the table at the top of
  **Phases** maps them). The spec is the source of truth for behavior.
- Run `git log --oneline -15` and `git status`.

## 2. Pick the phase and check preconditions

- If a phase number was given, use it. Otherwise pick the first phase whose
  status is `in progress`, and failing that the first one that is
  `not started`.
- If an earlier phase is `awaiting user`, check whether the user has done what
  it asks. For the lineage rebuild that means
  `bun specs/2026-10-playlists/probe.ts` exits 0.
  - If the user has done it, set that phase to `done`, clear its "Owed by the
    user" entry, and continue.
  - If not, and your phase needs it (the phase says so under
    **Precondition**), stop and report.
  - Otherwise continue, and mention it in your final message.
- **Stop and report without changing anything** if:
  - the chosen phase is already `done`,
  - an earlier phase is `not started` or `in progress`, or
  - the working tree has uncommitted changes you didn't make.
- You must be on the `playlists` branch. If you're on any other branch, stop
  and report.
- If the phase is `in progress`, its As-built note says what's left. Resume
  from there and don't redo finished work.

## 3. Do the phase, and only that phase

- Set the phase's status to `in progress` before you start.
- Read the existing code in your phase's scope before changing it, and keep its
  doc comments, updated where the mechanism changed. Match the surrounding code's
  idiom and comment density.
- Follow `CLAUDE.md`'s "Writing React" rules exactly.
- If the plan turns out to be wrong or unworkable, choose the smallest
  deviation that satisfies the spec and record it, with the reason, in the
  As-built note.
- If you hit a genuine product decision the spec doesn't settle, don't guess.
  Pick the conservative option, record it under **Open questions**, and say so
  in your final message.
- Anything worth doing that isn't in scope goes under **Deferred follow-ups**.
- **Never touch a `Cargo.toml` or `Cargo.lock`.** If a phase seems to need a
  dependency change, stop and ask.
- **Never run `track-lineage/build.sh`, `wasm-pack`, `cargo build` or
  `cargo run`.** When a phase needs one of them, set the status to
  `awaiting user` with the exact command in "Owed by the user".

## 4. Run the gate

Run the spec document's **Definition of done**, fixing failures as you go.

- Update a screenshot baseline only for a story your phase intentionally
  changes or adds, with `--grep` scoped to it. Look at every image you
  regenerate.
- An unexpected snapshot diff is a bug. Find the difference in markup, classes
  or timing. Don't regenerate it.
- If a check can't pass for a reason outside your phase (for example the
  backend test link failure described in the Implementation notes), record the
  exact failure and what you ran instead.

## 5. Hand off

1. Under your phase's section, add an `#### As built` subsection covering:
   - What landed, and where (the key files).
   - Where it departs from the plan, and why.
   - Anything left undone, and why.
   - What the next phase needs to know.
   - The snapshot baselines you added or regenerated, if any.

   Keep it factual and short.
2. Update the Status row: `done`, `in progress` with a few words on what
   remains, or `awaiting user`. Add anything the user must run or decide
   (a build, a decision) to "Owed by the user". Manual QA isn't owed per
   phase: add any manual check your phase needs to the spec's **Manual QA
   (after phase 9)** checklist instead, under your phase's group. A manual
   check never makes a phase `awaiting user`.
3. Commit everything in one commit on `playlists`, titled
   `Playlists, phase N: <phase title>`, with a body summarizing the As-built
   note. Include the Co-Authored-By trailer. **Don't push**, and don't amend,
   rebase or reset existing commits.
4. **Stop.** Don't start the next phase, even if you have context left.

Your final message should give:

- The phase number and its final status.
- The commit hash.
- Gate results: each check, pass or fail.
- Anything the user must do or decide before the next phase runs (build
  commands, open questions, baselines to review). Manual checks wait for
  the final Manual QA pass, so mention only the ones you added to that
  checklist.

If a check is failing, name it and paste the relevant output. Never mark the
phase `done` unless every check passed or its failure is recorded as
environmental.

## If you run out of room

Phases 1, 4 and 8 are the largest and may not fit. Once the remaining work
clearly won't fit, hand off early:

- Commit what passes typecheck and lint (and `cargo check`, for Rust).
- Set the status to `in progress`.
- Write an As-built note listing exactly which files and checks are still to
  do, precisely enough that the next `/playlist-next` can resume without
  guessing.
