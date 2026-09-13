---
description: Implement the next stage of the SolidJS → React frontend port
argument-hint: "[stage number — defaults to the first stage not marked done]"
---

You are implementing **one stage** of the frontend port described in
`specs/2026-09-react-migration/plan.md`. You have no memory of earlier stages.
The plan and git history are the only handoff, so read them carefully and leave
them accurate for the next session.

Requested stage: `$ARGUMENTS` (if empty, pick the stage as described in step 2).

## 1. Orient

- Read `CLAUDE.md`. Its validation rules apply. Never run `cargo build`, and this
  port touches no Cargo files at all.
- Read the plan's **Status**, **Starting a stage**, **State management** (all
  of it), **Migration strategy**, **Definition of done**, and **Risks**.
- Read every earlier stage's **As built** note. They record where reality
  departed from the plan, and they override the plan text wherever the two
  disagree.
- Run `git log --oneline -15` and `git status`.

## 2. Pick the stage and check preconditions

- If a stage number was given, use it. Otherwise pick the first stage whose
  status is `in progress`, and failing that the first one that is `not started`.
- **Stop and report without changing anything** if:
  - the chosen stage is already `done`,
  - an earlier stage isn't `done`, or
  - the working tree has uncommitted changes you didn't make.
- Branch:
  - You must be on `react-port`.
  - If that branch doesn't exist and this is stage 0, create it from `main`.
  - If you're on any other branch, stop and report.
- If the stage is `in progress`, its As-built note says what's left. Resume from
  there. Don't redo finished work.

## 3. Do the stage, and only that stage

- Set the stage's status to `in progress` before you start.
- **Port, don't redesign.** Read the Solid source for every file in scope
  *before* writing the React version, and keep its doc comments, updated where
  the mechanism changed. The Solid app is the spec for behavior.
- Follow the State management rules exactly. If a rule turns out to be
  unworkable, choose the smallest deviation that works and record it in the
  As-built note, with the reason.
- Anything worth improving that isn't in scope goes under **Deferred
  follow-ups**, not into this stage.
- Don't touch the Solid tree except where the stage says to. The Solid project
  has to stay green until stage 10.

## 4. Run the gate

Run the plan's **Definition of done** from `frontend/`, fixing failures as you
go.

- **Never update screenshot baselines.** Don't run `test:visual:update`, don't
  pass `--update-snapshots`, and don't edit anything under
  `tests/visual/__screenshots__/`.
- A React snapshot that doesn't match its baseline is a porting bug. Find the
  difference in markup, classes or timing.
- If a mismatch truly can't be avoided, stop. Leave the stage `in progress` and
  explain it in the As-built note and in your final message.

## 5. Hand off

1. Under the stage's section in the plan, add an `#### As built` subsection
   covering:
   - What landed.
   - Where it departs from the plan, and why.
   - Anything left undone (and why).
   - Anything the next stage needs to know.

   Keep it factual and short.
2. Update the Status row: `done`, or `in progress` with a few words on what
   remains.
3. Commit everything in one commit, titled
   `React port, stage N: <stage title>`, with a body summarizing the As-built
   note. Include the Co-Authored-By trailer. **Don't push**, and don't amend,
   rebase or reset existing commits.
4. **Stop.** Don't start the next stage, even if you have context left.

Your final message should give:
- The stage number and its final status.
- The commit hash.
- Gate results: each check, pass or fail.
- Anything the user should review or decide before the next stage runs.

If a check is failing, name it and paste the relevant output. Never call the
stage `done` unless every check passed.

## If you run out of room

Long stages (1, 7, 9) may not fit. Once the remaining work clearly won't fit,
move to handing off early:
- Commit what builds and passes lint and typecheck.
- Set the status to `in progress`.
- Write an As-built note that lists exactly which files and checks are still
  to do, precisely enough that the next `/port-next` can resume without
  guessing.
