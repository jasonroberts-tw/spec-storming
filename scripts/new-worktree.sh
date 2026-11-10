#!/bin/sh
# scripts/new-worktree.sh <task-ref> <slug>
#
# Makes one worktree for an agent task, for a CLI that has no worktree tool of its own: Codex,
# Copilot and OpenCode. It cuts `agent/<task-ref>-<slug>` from origin/main, adds the worktree locked,
# and runs that worktree's own scripts/setup-worktree.mjs, which sets the commit identity, copies
# the installed skills and renders the briefing. Claude Code makes its own worktrees, and a session
# there runs the same setup script as its first command, so everything a session relies on in a
# worktree is set by one file (that file's header says what the hook this replaced cost).
#
# It does not install dependencies. node_modules is gitignored and platform-native, and this script
# can run on a host for a session that runs in a container, so the session installs: its first
# command in the worktree is `node scripts/setup-worktree.mjs`, which runs `npm ci`. The summary
# printed below and the rendered briefing both say so.
#
# The worktree is added LOCKED, so git itself refuses to remove or prune it, however the command is
# spelt, until someone unlocks it (the block that adds it has the incident).
#
# Several runs at once, as a fan-out sweep starts them, do not fail one another: a run that fails
# deletes the branch it made, and only that one (the block that cuts the branch has the incident),
# and no run writes the shared .git/config but the first to set a commit identity in a repository,
# which turns on per-worktree config there, once (scripts/setup-worktree.mjs).
#
# POSIX sh. The prompts run it with `bash`, which runs it the same. Run from any checkout of the
# repository: it finds the primary one itself.

set -eu

# Two calling conventions. `<task-ref> <slug>` is the one the prompts give. The single-argument form
# takes an already-composed name. Both land on the same NAME, so there is one code path below.
TASK_REF="${1:?usage: new-worktree.sh <task-ref> <slug> | new-worktree.sh <name>}"
SLUG="${2:-}"
if [ -n "$SLUG" ]; then NAME="${TASK_REF}-${SLUG}"; else NAME="$TASK_REF"; fi

# The PRIMARY checkout, never the current one. `--show-toplevel` answers with the worktree you are
# standing in, so running this from inside a worktree nested the next one underneath it -- measured
# as ../worktrees/worktrees/<name>. `--git-common-dir` is shared by every worktree and is always
# `<primary>/.git`, so stripping that suffix gives the primary working tree from anywhere.
REPO_ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
# Worktrees live inside the selected CLI's worktrees folder. HARNESS_CLI overrides the recorded
# selection when several integrations are deployed. Each folder is gitignored to prevent phantom
# gitlinks.
HARNESS_CLI="$(node "$REPO_ROOT/tools/integrations/adapters.mjs" "$REPO_ROOT")"
export HARNESS_CLI
WORKTREE_ROOT="${WORKTREE_ROOT:-$REPO_ROOT/.$HARNESS_CLI/worktrees}"
LIFETIME_HOURS="${LIFETIME_HOURS:-2}"
export LIFETIME_HOURS

BRANCH="agent/${NAME}"
WORKTREE_PATH="${WORKTREE_ROOT}/${NAME}"

# Anything that fails AFTER the branch is made has to undo what this run made, and only that.
# Without this, a failure in the renderer left the worktree and the branch on disk, and the obvious
# fix -- run the script again -- died on `fatal: a branch named 'agent/...' already exists` with no
# hint that the way out is `git worktree remove` plus `git branch -D`. The trap once acted only once
# the worktree existed, so a `worktree add` that failed after making the branch left the branch
# behind with no worktree (the incident is below). BRANCH_MADE is set only once this run's own
# `git branch` succeeds, so a branch that existed before the run is never this trap's to delete.
BRANCH_MADE=0
CREATED=0
cleanup() {
  code=$?
  if [ "$code" -ne 0 ] && [ "$CREATED" -eq 1 ]; then
    echo "provisioning failed (exit $code); removing the worktree" >&2
    # Twice --force: once for a worktree with changes in it, and once more for a locked one.
    git -C "$REPO_ROOT" worktree remove --force --force "$WORKTREE_PATH" 2>/dev/null || true
  fi
  if [ "$code" -ne 0 ] && [ "$BRANCH_MADE" -eq 1 ]; then
    echo "provisioning failed (exit $code); deleting $BRANCH, the branch this run made" >&2
    git -C "$REPO_ROOT" branch -D "$BRANCH" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

# The trunk is `main` -- see AGENTS.md § Git workflow. Overridable so a hotfix worktree can be cut
# from a release branch without editing this script.
TRUNK="${TRUNK_BRANCH:-main}"
TRUNK_BRANCH="$TRUNK"
export TRUNK_BRANCH

# A failed fetch must not block provisioning. `set -e` used to abort here, which was tolerable when a
# human ran the script and could retry, but a session can run this from inside a sandbox where the
# network is unreachable -- an aborted fetch there means no worktree at all. Basing off a local
# `origin/main` that is minutes stale is strictly better than that, so the failure warns and
# continues. It is not silent: the base commit's date is printed below, which is what tells the
# operator the ref is old.
if ! git -C "$REPO_ROOT" fetch origin "$TRUNK" --quiet 2>/dev/null; then
  echo "warning: could not fetch origin/$TRUNK (offline or sandboxed); using the local ref" >&2
fi
BASE_SHA="$(git -C "$REPO_ROOT" rev-parse --short "origin/$TRUNK")"
BASE_DATE="$(git -C "$REPO_ROOT" log -1 --format=%ci "origin/$TRUNK")"

# The branch is cut with --no-track, and before the worktree, in two steps. On 2026-09-26 a fan-out
# sweep launched eleven lanes at once and two WorktreeCreate hooks failed with "could not lock config
# file .git/config: File exists": `git worktree add -b ... origin/main` set the
# new branch's upstream, a write to the one `.git/config` every worktree shares, and concurrent runs
# race for its lock. On 2026-10-03, 30 concurrent runs of a scratch copy failed 3 times so, and 50 of
# this one none. With --no-track no run writes the config at all, so there is no lock to race for,
# nothing to retry and no serialising lock of this script's own to leave stale; nor two keys per
# branch left behind in the shared config. The branch needs no upstream:
# the briefing rebases onto origin/main by name, `open-pr`'s `git push -u` sets the pushed branch as
# the upstream, and `mise run gates` reads a branch with none as new, from its merge base with
# origin/main (scripts/git-hooks.mjs). Where it loses: a bare `git pull --rebase` in a worktree not
# yet pushed, which rebased onto origin/main, now stops on git's "no tracking information" until the
# push; `git pull --rebase origin main` names the base. The second step is what lets the trap tell
# its own branch from another's: `git worktree add -b` makes the branch and then fails on an
# occupied path, so its exit status cannot say whether the branch it failed with was its own.
git -C "$REPO_ROOT" branch --no-track "$BRANCH" "origin/$TRUNK"
BRANCH_MADE=1

# Added locked. A lock makes git refuse `git worktree remove` and `git worktree move` on this
# worktree, and makes `git worktree prune` keep its record even when git cannot see its directory.
# On 2026-10-06 a prune run in a dev container, where every worktree made on the host has a path the
# container cannot see, took the record of every one of them. scripts/hooks/guard-git.mjs refuses a
# prune a session types, but that prune was run by a hook, which no command guard reads; a lock
# holds whoever runs it and however it is spelt. `--lock` on the add leaves no moment between the
# add and the lock. Where it loses: a session that ends without removing its worktree leaves the
# lock, and nothing clears it but `git worktree unlock <path>`, which the removal the prompts give
# runs first.
LOCK_REASON="an agent's worktree for $BRANCH, in use until its work has merged; unlock it only to remove it then"
git -C "$REPO_ROOT" worktree add --lock --reason "$LOCK_REASON" "$WORKTREE_PATH" "$BRANCH"
CREATED=1

echo "base:     $BASE_SHA, $BASE_DATE"

# The identity, the installed skills, the ports and the briefing: the NEW worktree's own setup
# script, never $REPO_ROOT's, and run from inside the worktree. This checkout's working tree can
# trail the base, so running its copy handed a worktree cut from origin/main a briefing from the
# checkout's older template (scripts/render-worktree-context.mjs's header, item 4, has the
# incidents). The worktree's copy is the base's. `--no-install` because this script may run on
# another platform than the session (the header says why); the setup prints the summary.
(cd "$WORKTREE_PATH" && node scripts/setup-worktree.mjs --no-install --task "$TASK_REF" "$NAME")

echo
echo "start the agent with:  cd '$WORKTREE_PATH' && $HARNESS_CLI"
# node_modules is gitignored, so `git worktree add` does not bring it across and nothing here
# installs it -- an unprovisioned checkout fails every gate on a missing binary. The briefing says
# so too; this line is for whoever is reading the terminal instead.
echo "first command there:   node scripts/setup-worktree.mjs   (it runs npm ci: a fresh worktree has no node_modules)"
