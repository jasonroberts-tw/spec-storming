## Rules for agents live in tracked files, and nowhere else

A rule an agent has to follow has one and only one home: this file, skills, agent
definitions, or the header of the tool or gate that enforces it. Change it there. 
A rule with two homes has one that is stale.
The one exception is outside text, loaded word for word: a plugin or an installed skill that
`policy/skill-sources.json` names, which only the `add-skill` skill's checks admit.

## Memory tiers

Memory is handled in tiers, based on the scope.
1. Environment memory - machine-specific setup and tool locations; keep outside the repository
   and verify against the current machine before use.
2. Harness memory - durable decisions and rules in the tracked files named above.
3. Work tracking - harness and product issues in beads.
4. Session memory - temporary notes in the conversation or `.scratch/`; move durable decisions
   into tracked files before the session ends.

## Verification before claiming

Never state a count, a figure, a "resolved" status, an option's effect or a fact about the
environment derived from titles, memory or inference. Re-derive every number you write, a message to
the user included, from the repository at the time of writing. Cite the source path inline. If you
cannot verify a figure, say so.

The same holds for a fact a session hands a subagent. A premise in a brief is verified first and
given with its source, or given as a question for the subagent to check. A subagent that finds a
premise false builds on what it found, not on the brief, and names the false premise in its report:
what it builds on a premise it knows is false is work someone later replaces.

## Delivery workflow

Every change moves from request to merged code on one of these tracks. Pick the track before
starting, and state it; when it is unclear, ask the operator.

| Track | Use when | Skills, in order |
|---|---|---|
| Feature | New or changed behaviour | `refine`, `design`, `plan-stories`, `work` for each story, `review-feature` |
| Defect | Existing behaviour does not match its spec or acceptance criteria | `work` |
| Small change | No change to observable behaviour, a contract or a non-functional target: a refactor, a dependency update, internal cleanup | `work` |
| Harness task | A `task` with no feature above it that changes the harness and no product code | `work` |

In a skill, MUST and MUST NOT are hard requirements. SHOULD is the default, and a departure states
its reason in the spec or the review report. MAY is optional. When a rule does not fit the situation,
or two rules conflict, stop and ask the operator: a rule picked silently is a decision nobody made.

In an existing codebase, read its architecture documentation, its conventions and the specs under
`specDirectory` (`policy/delivery.json`) before Design, or before the first change on the other
tracks. New work follows existing conventions unless a decision record explains the departure.

No implementation code for a feature is written before the operator approves its spec at Gate 2
(the `design` skill), because code built on an unapproved design is rebuilt when the design moves.
Approval is the spec on `origin/main` saying `Design approved`. Until then,
`scripts/hooks/guard-delivery.mjs` refuses a story's writes outside `beforeApprovalPaths`.

**Protected tests.** A functional, integration, contract or end-to-end test, or a fitness function,
written from a spec's test plan is protected from the commit that adds it, and so is a test that
reproduces a defect. That commit lists it in `protectedTestsFile` (`policy/delivery.json`), and the
same hook refuses an edit to a listed test. Never modify, weaken, skip or delete one: a test changed
until it passes proves nothing. If a protected test, or the contract behind it, looks wrong, stop,
say why, and wait. Only the operator approves a change to one, by making it or by deleting its line
in a commit of their own, and a changed contract changes the spec too.

**New dependencies.** Before adding a third-party dependency, confirm that it exists in the official
registry under that exact name, that it is maintained, that it is needed, and what licence it
carries. A copyleft licence, or none, goes to the operator before the install, because code built on
a dependency the project cannot ship is rewritten. Record why, and the licence, in the spec or the
story's notes: a misremembered name installs whoever registered it.

## Git workflow

The trunk is `main`. Agent work happens on `agent/<name>` branches cut from
`origin/main` by the one worktree script, and reaches the trunk by pull request. `<name>` starts
with the id of the issue the branch carries, because the delivery hook finds the issue there. Name the base
explicitly on every pull request, because a tool that infers one infers the default branch. The
protected branches are main, release: never push to, switch to or rewrite one from a
worktree. 

## Worktree-local context

Read `.worktree/CONTEXT.md` when it exists. Its briefing wins where it and this file disagree;
outside a worktree the worktree script made, no briefing exists.

## Guards

A refused command or edit is never retried in another shape that reaches the effect the refusal
judged: in pieces, through another tool or subagent, or through an allow rule the session writes
itself. Each of those gets past a judgement the session cannot overrule. Read the refusal's reason
(not verified against the CLI), then take the first case that fits:

- **Wrong, or no longer needed.** The refusal shows the plan was wrong, or the command's effect is
  in place or no longer wanted. Do what the refusal says instead, and give the dropped command one
  line of the report, since a block would hand the user what the refusal was right to stop; a
  criterion it shows cannot be met goes to the user. A smaller check that passed in its place does
  not make it unneeded.
- **Its form, not its effect.** A check refused how the call was written, or could not parse it,
  and another form, or a dedicated tool, does the same work without what was refused. Run that once, since form after form until one passes is the retry barred above; refused
  again, take the next case.
- **Later work needs it.** Finish the work that does not, then stop and give the exact command for
  the user to run as `! <command>`, which puts its output in the session (not verified against the
  CLI), and go on from that output, since a block at the end leaves that work undone.
- **Nothing later needs it.** Keep going, and end the report with one `RUN THESE YOURSELF` code
  block of the commands still needed, in order, each with a comment above it saying why it should
  run and one below it saying the result to expect, or the user can neither judge it nor tell
  whether it worked. Hold back a command whose safety turns on an earlier one's output until the
  user reports that output: a pasted block runs whole.

A command the user declined at a permission prompt is neither retried nor listed, since a block
would hand back what they refused: the report says what it leaves undone and asks how to go on. A
legitimate command refused run after run may be named in the report for the user's allow-list.

A command a subagent reports refused may be run once by the session that launched it, as its own
single call: the classifier judges each call in its own context, so a subagent's refusal is not its
parent's (not verified against the CLI). Refused again, it takes the cases above.

A refusal saying you are isolated in a worktree is not the classifier's
(verified against the CLI, 2.1.292): redo the work once in a form the isolation can check.

## Decisions records

Decisions are recorded in markdown files and stored in `docs/decisions`
The `should-i-adopt` skill is the current primary method for adopting a decision,
which defines the format of the decision record. The `design` skill writes a feature's decision
records there too, in the same format, and the feature's spec links them.

## Every directory and document says what it is, and who wins

A directory that holds more than one file of one kind has a `README.md`: a bolded one-sentence
thesis of the directory's role, then a table with one row per file saying what it is or, for a
gate, what it refuses. The row lands in the same change as the file. Every dated document opens with a `**Written:**`
line and, once something amends it, a `**Status:**` line naming what did; it stays true about its
date and is superseded rather than refreshed. Every document that can
disagree with another says, in one sentence, which wins.

## Three kinds of file, and never a fourth

Hand-maintained source, which a person edits. Hand-authored decision records (JSON), which emitters
read and nothing writes, each self-describing with `describes`, `whyThisFileExists`, `gatedBy`,
`whatItDoesNOTDo` and `provenance` before its data, and for each constant a `<key>Means` sibling
stating what the value decides and where it is changed. A table keyed by what it governs carries
each row's reason in the row. Either way, a reader needs to know what a record changes and what it
leaves alone before the array.
Generated output under `artifacts/`, which nothing edits by hand: it carries a banner naming its
emitter, and a correction goes into the hand-maintained source, so the next run carries it. A
constant a tool or a prompt reads lives in a policy file under a key, and is stated nowhere else.

## The script suffix contract

A task named `<group>:<verb>` in `tasks.toml` is a public name. The bare name writes the
artifact. `:check` re-derives it in memory, diffs against what is committed, exits 1 on any
difference or on a stale file a fresh run would not write, and writes nothing. `:selftest` asserts
invariants from fixtures it builds under the temporary directory. `:update` moves a baseline.

Every emitter obeys the same rules from its first commit. It has no timestamp and no randomness. It
has one canonical serialiser. It sorts by code point so two runtimes agree. Its `:check` twin lands
in the same change. An emitter that walks a graph compares its walk with a hand-ratified fixture. It
refuses to write on disagreement, because a wrong walk returns a smaller answer and says nothing.

## The gate ladder

The same checks run at four latencies, and a slower tier never trusts a faster one:

| Tier | Latency | Shape |
|---|---|---|
| In-session hooks (`scripts/hooks/`) | milliseconds | may be unsound; never block a stop |
| Pre-commit (`git-hooks.yml`) | seconds | sequential; rejects whitespace errors in the staged diff |
| Pre-push (`git-hooks.yml`) | tens of seconds | parallel, each job scoped by a glob of what it reads |
| `.github/workflows/verify.yml` | minutes | every gate, binding on every pull request and every push to `main` |

Where a check runs is decided by what it reads. A check that reads only committed files is a
pre-push job **and** a `.github/workflows/verify.yml` step, even one that talks over loopback to a server it starts from them. 
A legitimately absent input skips clean and prints why; a tool that is found and then fails is a
failure, never a skip.

## Standing rules for prompts and gates

Each of these holds from the first file it applies to, and for every one after it.
- **A rule in a prompt states the failure it prevents in one clause, and carries no incident.** In
  `AGENTS.md`, a skill or an agent, the dated incident behind a rule goes in the description of the
  pull request that adds or changes the rule, because every session loads the prompt and only the reader who edits the rule needs the incident. That reader finds it from the prompt:
  `git log --format=%h origin/main -- <prompt>` lists the commits that changed it, and
  `gh api repos/{owner}/{repo}/commits/<commit>/pulls` names the pull request each one landed from.
- **Every gate and every guard has a selftest.** It builds its inputs under the temporary directory,
  breaks exactly one thing per case, asserts the run fails **for that reason**, and keeps one
  undoctored control case that must pass, without which every other case could be failing on the copy. A case that only sees "refused" passes with the refusal deleted whenever something else refuses first. A gate's is a `:selftest` task of its name, run as its own pre-push job.
- **Every gate has a root override**: an environment variable naming a doctored copy, so a by-hand run can point the gate at a fixture without editing it.
- **Every script under `scripts/`, every emitter under `tools/` and every hook under
  `scripts/hooks/` opens with a header of four parts, in this order.** They are: what it emits or
  checks; **the failure mode it exists to prevent**, as the incident that happened, dated, with the wrong
  fix tried first where there was one; the invocation with its flags; and what it needs (another
  checkout, a token, a network). On day one, with no incident yet, that paragraph says what the
  script would let through if it were wrong, and the first incident replaces it. It is the one to keep
  when cutting: a gate whose header says only what it
  checks is the one the next person weakens to make a push go through. A measured cost lives there
  too, so "why is this not a pre-push job" is answerable from the file. An emitter's header adds
  four labelled lines: `KIND` (its lifecycle), `INVARIANTS` (what it never does), `RE-ENTRY`
  (whether a second run is idempotent, and what `--check` does) and `STALE WHEN` (the inputs whose change makes its output stale). A ten-line helper can carry one sentence.

## Citations

Cite a document by section, `<file>.md § "<Heading>"`, not by line: a line pointer rots on every edit above it.
