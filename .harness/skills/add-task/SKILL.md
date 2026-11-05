---
name: add-task
description: use this skill when adding, renaming or removing a task in tasks.toml — including a new emitter, gate, check or selftest that will be run as `mise run <name>`.
---

A task in `tasks.toml` is a public name. Prompts, tool headers, the READMEs and policy files
cite it as prose, and **nothing in this repository gates those citations** — a renamed task
leaves dead references behind that stay green forever. Treat the
name and the documentation as part of the change, not as follow-up.

## 1. Name it

`<group>:<verb>`. Reuse an existing prefix wherever one fits; a new prefix starts a group of public
names, which is a decision, not a side effect. A person makes it when they merge the pull request,
so the pull request's description names the new prefix and says why no existing one fits.

The suffixes are the bare name, `:check`, `:selftest` and `:update`, and what each one must do is
`AGENTS.md` § The script suffix contract. An emitter's `:check` twin in particular is how a
reviewer trusts a committed artifact.

A third segment only when it names a sub-artifact rather than a variation.

## 2. Put the code where its neighbours are

A node emitter with its own module tree goes in `tools/<name>/*.ts`, run by plain `node`. Node
22.18+ strips the types itself, so write every relative import with its `.ts` extension, and use
no enums, namespaces or parameter properties, which the stripper cannot erase. A gate is one file,
`scripts/*.mjs`, run with `node`. Match the neighbours and add no new runtime: a launcher adds its
start-up time to every run of every script it starts.

Open the file with the header its neighbours use. It says what the file emits, **the failure it
exists to prevent**, the `mise run <name>` call with its flags, and what it needs from outside this
repository.

## 3. If it writes an artifact, make it deterministic

An unchanged input produces byte-identical output. That is what makes the artifact diffable in
review, and it is the precondition for a `:check` twin. The rules that get there, the twin landing
in the same change among them, are `AGENTS.md` § The script suffix contract.

## 4. Decide gating from what it reads, not from how much you trust it

- **Reads only committed files** → it can be a `pre-push` job *and* a CI step, even when it talks
  over loopback to a server it starts from them.
- **Reads another checkout** → it can be neither. CI does not clone that checkout, so a `--check`
  there would compare a real artifact against one with every source-derived signal zeroed. Say so
  in the header; its selftest over fixtures is the job and the step (`AGENTS.md` § The gate ladder).
- **Legitimately-absent input** → skip clean with a message, never fail. A gate that is red on every
  fresh clone gets bypassed with `--no-verify`, which costs you every other gate too.

Then wire it: a job in `git-hooks.yml` under `pre-push`, a step in `.github/workflows/verify.yml`,
or both. The job is `run: mise run <name>`, plus a `glob` listing every file whose change can
alter its verdict, re-derived from what the script reads and imports.  
When in doubt, make it wider: a too-narrow glob is a gate that silently stops
running on a real push, and `mise run gates` runs every job regardless.

## 5. Write its description

- Its `description` in `tasks.toml` says what the task does and what breaks without it, in a `'''`
  string wrapped as its neighbours' are: the citations gate reads the file as written, and misses a
  pointer a basic string spells through an escape. It does not restate the `run` line beside it:
  two copies means one goes stale.
- Any figure in it must be re-derived at the time of writing, with no exceptions for numbers copied
  out of a source comment. Those drift silently, because a numeral in a comment is not an input to
  anything.


## 6. Renaming or removing one

Do all three, in any order. 

1. Delete or rewrite the `tasks.toml` entry.
2. Remove the `git-hooks.yml` job and the `verify.yml` step. 
3. Search tracked files of every type for the bare name, one call per name:
   `git grep -n -w -F <old-name>`. Fix every live hit. Most citations carry no `mise run`: the
   READMEs cite the name in backticks, `policy/*.json` in a `gatedBy` string, and a gate keeps
   it as a quoted string in a list. A recursive `grep` also walks `node_modules/` and, from the
   primary checkout, every worktree. Two keep their hits: the
   register, whose entries are never rewritten

A retired task's references are worth leaving *only* as an explicit comment saying it is retired
and why; the CI workflow is where such a comment belongs.

## 7. Verify before you claim it works

```bash
mise run <new-task>
mise run gates
```

Confirm your job actually fired rather than silently matching nothing: check that its name appears
in the run's output. A job that never fires is worse than no job, because you will now defend the
green result.

One at a time, delete each refusal or check the script makes, rerun its selftest and restore it:
each deletion must turn a case red, or nothing holds it.

Run each command as a separate Bash call, so a red result names the step that produced it.
