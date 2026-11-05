#!/usr/bin/env bash
# scripts/new-worktree.sh <task-ref> <slug>
#
# Creates one isolated worktree per agent task: a branch off origin/main, a checked pair of
# ports, and a rendered .worktree/CONTEXT.md briefing that the committed AGENTS.md asks each session to read.
#
# There is no database, container stack or .env to provision -- this repository is a Node/TypeScript
# toolchain. An earlier version of this script copied .env, certs and appsettings.Development.json
# and wrote COMPOSE_PROJECT_NAME/DB_NAME/DB_PORT into .env; none of those files or services exist
# here, so every line of it was inert. The port pair is reserved so that two worktrees never
# collide: the first is the PORT to give a server a person starts there, the second is unused.
# scripts/render-worktree-context.mjs owns the pair.
#
# It also does not install dependencies. node_modules is gitignored and platform-native, so the new
# checkout has none; `npm ci` is the first command inside the worktree, and both the summary printed
# below and the rendered briefing say so.
#
# Several runs at once, as a fan-out sweep starts them, do not fail one another: no run writes the
# shared .git/config, and a run that fails deletes the branch it made, and only that one
# (the block that cuts the branch has the incident).
#
# Run from the primary checkout.

set -euo pipefail

# Two calling conventions. `<task-ref> <slug>` is the orchestrator's, and the one the briefing's
# prose is written around. The single-argument form takes an already-composed name, and exists for
# scripts/hooks/worktree-create.mjs: the harness hands that hook one opaque worktree name with no way
# to split it back into a bead ref and a slug. Both forms land on the same NAME, so there is one code
# path below and no second way for a worktree to get provisioned.
TASK_REF="${1:?usage: new-worktree.sh <task-ref> <slug> | new-worktree.sh <name>}"
SLUG="${2:-}"
if [ -n "$SLUG" ]; then NAME="${TASK_REF}-${SLUG}"; else NAME="$TASK_REF"; fi

# The PRIMARY checkout, never the current one. `--show-toplevel` answers with the worktree you are
# standing in, so running this from inside a worktree nested the next one underneath it -- measured
# as ../worktrees/worktrees/<name>. `--git-common-dir` is shared by every worktree and is always
# `<primary>/.git`, so stripping that suffix gives the primary working tree from anywhere.
REPO_ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
# Worktrees live inside the selected CLI's worktrees folder. Claude uses its native location;
# Codex, Copilot and OpenCode invoke this script explicitly. HARNESS_CLI overrides the recorded selection when
# several integrations are deployed. Each folder is gitignored to prevent phantom gitlinks.
HARNESS_CLI="$(node "$REPO_ROOT/tools/integrations/adapters.mjs" "$REPO_ROOT")"
export HARNESS_CLI
WORKTREE_ROOT="${WORKTREE_ROOT:-$REPO_ROOT/.$HARNESS_CLI/worktrees}"
LIFETIME_HOURS="${LIFETIME_HOURS:-2}"

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
  local code=$?
  if [ "$code" -ne 0 ] && [ "$CREATED" -eq 1 ]; then
    echo "provisioning failed (exit $code); removing the worktree" >&2
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_PATH" 2>/dev/null || true
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

# A failed fetch must not block provisioning. `set -e` used to abort here, which was tolerable when a
# human ran the script and could retry, but scripts/hooks/worktree-create.mjs calls this from inside
# the agent sandbox where the network is unreachable -- an aborted fetch there means the harness
# cannot create a worktree at all. Basing off a local `origin/main` that is minutes stale is strictly
# better than that, so the failure warns and continues. It is not silent: the base commit's date is
# printed below, which is what tells the operator the ref is old.
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
git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH"
CREATED=1

# Installed skills (policy/skill-sources.json `installedSkills`) are untracked directories in the
# primary checkout, so git does not bring them across; copy them from there, with no network. A
# skill held by its audit is absent there, so it is not copied. A worktree cut before a change keeps
# what it had. Diagnostics only, on stderr: the WorktreeCreate hook reads stdout as the path.
if [ -f "$REPO_ROOT/scripts/skill-sources.mjs" ]; then
  node "$REPO_ROOT/scripts/skill-sources.mjs" copy "$WORKTREE_PATH" >&2 \
    || echo "warning: could not copy the installed skills into $WORKTREE_PATH" >&2
fi

# Ports, timestamps and the briefing. See the renderer's header for why this is not another `sed`.
# The NEW worktree's renderer, never $REPO_ROOT's: the renderer reads the template beside itself, and
# this checkout's working tree can trail the base, so running its copy handed a worktree cut from
# origin/main a briefing from the checkout's older template (the renderer's header, item 4, has
# the incidents). The worktree's copy is the base's, template and all.
RENDER="$(node "$WORKTREE_PATH/scripts/render-worktree-context.mjs" \
  "$WORKTREE_PATH" "$BRANCH" "$BASE_SHA" "$TASK_REF" "$LIFETIME_HOURS")"

value_of() { printf '%s\n' "$RENDER" | sed -n "s/^$1=//p"; }

echo "worktree: $WORKTREE_PATH"
echo "branch:   $BRANCH (from $BASE_SHA, $BASE_DATE)"
echo "ports:    $(value_of APP_PORT) / $(value_of SB_PORT) (reserved: the first for a server's PORT, the second unused)"
echo "deadline: $(value_of DEADLINE)"
echo
echo "start the agent with:  cd '$WORKTREE_PATH' && $HARNESS_CLI"
# node_modules is gitignored, so `git worktree add` does not bring it across and nothing here
# installs it -- an unprovisioned checkout fails every gate on a missing binary. The briefing says
# so too; this line is for whoever is reading the terminal instead.
echo "first command there:   npm ci   (a fresh worktree has no node_modules)"
