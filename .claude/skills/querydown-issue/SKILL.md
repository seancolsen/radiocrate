---
name: querydown-issue
description: Turn a Querydown problem found in RadioCrate (wrong SQL, a bad error, a missing feature) into a handoff prompt for an agent working in the Querydown repo, reproduced in terms of Querydown's sample issue-tracker schema with no reference to RadioCrate. Use when the user wants to hand off, report, or get another agent to investigate a Querydown bug or gap.
argument-hint: "[the Querydown problem, or nothing to use the one under discussion]"
---

# Hand off a Querydown issue

You're preparing a handoff. The person who reads your output is an agent working
in the Querydown repo, with no knowledge of RadioCrate. It should be able to
start from a few lines it can paste into the Querydown CLI, and trust that
they show the problem.

The problem to hand off: `$ARGUMENTS`. If that's empty, use the Querydown
problem under discussion in this conversation. If there isn't one, ask.

You don't change anything in either repo: no fixes, and no edits to the
Querydown checkout. The output is one prompt.

## 1. Get the Querydown checkout

The checkout lives at `target/querydown-src`. It's gitignored, a build cache
that `cargo xtask` clones. RadioCrate pins Querydown at `QUERYDOWN_REV` in
`xtask/src/main.rs`, and the vendored compiler
(`frontend/vendor/querydown-js`) is built from that rev.

- If the checkout is missing, clone it:
  `git clone https://github.com/seancolsen/querydown target/querydown-src`.
- Check it out at the pinned rev (`git -C target/querydown-src checkout <rev>`),
  so that its docs and sample schemas match the compiler you're probing. Note
  the rev for the prompt.
- Don't run `cargo xtask` or any cargo command to build it. The probe below
  needs no build.

## 2. Reproduce it in RadioCrate's terms first

Pin down the symptom where it was found before translating it. Use the bundled
probe, which compiles with the vendored WASM:

```sh
bun .claude/skills/querydown-issue/probe.ts --schema radiocrate --dialect duckdb '#credit track.title:x $id'
```

`--schema radiocrate` is the record fixture's schema
(`frontend/src/dev/recordFixture.ts`), with links inferred the way the app
infers them. Take each query as a whole Querydown query. Lines like `@x = 'v'`
can go ahead of it. If the problem came from `compile_sections`, write the
sections out as one query, then check that the problem survives.

## 3. Translate it to the issue-tracker schema

Read `target/querydown-src/compiler/resources/test/issue_schema.dbml` for the
tables and links. `issue_schema.json` is what compiles. The links include:

- `issues.project → projects`, `issues.author → users`,
  `issues.duplicate_of → issues` (a self-link)
- `comments.issue → issues`, `comments.user → users`
- `assignments.issue → issues`, `assignments.user → users`
- `issue_labels.issue → issues`, `issue_labels.label → labels`
  (a many-to-many)
- `blocks.blocker` and `blocks.blocking → issues` (two links to one table)
- `users.team → teams`, `projects.product → products`,
  `products.client → clients`

Find the same shape there: the same pattern of links walked out (to one) and
back (to many), the same column types. Then choose queries a person would
actually want, ones you can say in a sentence, like "issues whose author wrote
comment 5". That sentence is what makes the expected SQL obvious. A literal
mapping of RadioCrate tables usually gives a contrived query that's hard to
picture.

If the issue schema has no matching shape, `library_schema.json` is the other
sample (`--schema library`). Use a hand-written schema only as a last resort,
and put it in the prompt in full.

## 4. Pin the trigger down

Probe with `--schema issue`. The default dialect is postgres, as in the
Querydown CLI; use another only when the problem depends on it.

```sh
bun .claude/skills/querydown-issue/probe.ts '#issues author{++#comments{id:5}} $id' '#issues author{#comments:>3} $id'
```

- **Find the smallest query that shows it.** Drop every clause that isn't
  needed.
- **Change one thing at a time** to find the boundary: the operator, the depth,
  braces versus a dotted path, with or without a filter, and a link to a
  different table. Several queries per call is fine.
- **Keep the controls:** near neighbours that compile correctly. They tell the
  other agent what the broken path is, so a table of wrong next to right is
  worth more than more wrong cases.
- **Check the unscoped or flat form** of the query, where one exists. "This
  works on its own but not inside X" is the strongest evidence there is.
- **Read the SQL to work out what it actually means**, and write that down in
  words, next to what the Querydown means.
- **Watch for "correct by coincidence"**: cases that only come out right
  because two paths happen to agree. Name them as such.

What you find here may be broader or narrower than the symptom you started
from. Report what you found, not what you expected.

## 5. Establish that it's a bug

Look in `target/querydown-src/docs/language.md` (and `docs/cheat-sheet.md`)
for the passage that says what the query should do. Quote or cite it in the
prompt. If the docs don't settle it, say so, and present the issue as a
question or a feature request rather than a bug.

To see which tests exist near the problem, look in
`target/querydown-src/compiler/src/tests/`. Many of those tests compile against
the issue schema.

## 6. Write the prompt

Save it in the scratchpad as `querydown-<short-slug>-prompt.md`, using this
outline:

1. **One opening paragraph:** what goes wrong, in a sentence, and that it's
   silent if no error is raised.
2. **Reproducing it:** the CLI command, which the other agent can run as is:
   `cargo run -q -p querydown-cli -- compile --schema compiler/resources/test/issue_schema.json '<query>'`.
   Then the simplest case: the query, what it should mean (with the docs
   passage), the expected SQL, and the actual SQL. Trim the SQL to what
   matters, but don't invent any of it. Expected SQL you wrote by hand is
   labelled as expected.
3. **A table of variations**, wrong and correct together, each with a few
   words on why.
4. **Further cases** that show how wide the problem is, each with its sentence.
5. **A hypothesis, marked unverified.** Say that it comes from reading the SQL,
   not the source.
6. **What you'd like:** confirm it at `HEAD` (it was found at rev `<rev>`),
   find the root cause, fix it, add regression tests (name the test file and
   any helper that fits), and report the cause and anything else on the same
   faulty path.

Before handing it over, check that nothing of RadioCrate leaked into it:

```sh
grep -inP 'radiocrate|track(?!er)|album|artist|credit|playlist|preset|@id|record editor|contextual|egui|duckdb' <prompt file>
```

"Issue tracker" doesn't count. Every hit should be a deliberate choice: a dialect that really matters, for
example. Re-run every query in the prompt through the probe one last time, so
that each "wrong" and "correct" in it matches what the compiler does now.

## 7. Hand it over

Start your reply with the line `Written for: a coding agent working in the
Querydown repo, with no knowledge of RadioCrate.` Then:

- Explain the problem to the user in two or three sentences, in issue-tracker
  terms. Say how it differs from what you thought at first, if it does.
- Say what it means for RadioCrate: which of its generated or seeded Querydown
  is affected.
- Give the file path, and the prompt itself in a `~~~~markdown` fence (the
  prompt contains ``` fences), ready to paste.
- Say how you tested: the vendored WASM at which rev, and that you built
  nothing.

Nothing in the repo changed, so there's no commit, unless the work also turned
up something worth fixing in RadioCrate and the user asked for that.
