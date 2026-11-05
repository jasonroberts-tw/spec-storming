#!/usr/bin/env bash
# The container's own clone of the repository, made at the first start in the workspace volume
# devcontainer.json mounts, since no host checkout is mounted, and then the steps only the container
# can take, because each one reads that clone or the volume and neither exists at build time:
#
#   1. the clone                  -- clone(), from the policy the image holds, at the first start.
#   2. ~/.claude's ownership      -- a volume made before the image had that directory arrives
#                                    root-owned.
#   3. the commit identity        -- the agents' GitHub App's bot account, read from the clone's
#                                    policy, set when ~/.gitconfig has no email.
#   4. Claude Code's status line  -- .devcontainer/statusline.sh, set in the volume's settings when
#                                    they set none: a volume made before the image changed keeps
#                                    what it held.
#
# ...and then scripts/bootstrap.mjs --container --warn-only, the one home of every setup step a
# program can run, which the host runs too: `npm ci`, the git hooks, the Tracker's hydration, the
# plugins and installed skills of policy/skill-sources.json, and last the doctor, whose probes
# replace the warnings this file once printed itself (a tool mise.toml pins missing from the image,
# a GitHub App that cannot mint a token). Before bootstrap existed this file held those steps and
# the README held the host's, and the two drifted.
#
# Wired to ENTRYPOINT by the Dockerfile so that devcontainer.json needs no lifecycle command. Runs
# on every container start, which is why every step below is idempotent and cheap when there is
# nothing to do.
#
# Nothing here is allowed to fail the container. This is the process that starts the shell you would
# use to fix a setup problem; exiting non-zero would lock you out of it. Every step warns and
# carries on, and bootstrap gets --warn-only for the same reason.

set -uo pipefail

log() { printf '\033[36m[devcontainer]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[devcontainer]\033[0m %s\n' "$*"; }

# The clone, once setup() has found it; the later steps work in it.
workspace=''

# The copy of the policy record the Dockerfile puts in the image, which names the repository clone()
# clones: the clone's own copy does not exist yet. WORKSPACE_ENTRYPOINT_POLICY names a doctored copy,
# as scripts/github-app-token.mjs's selftest sets it.
policy="${WORKSPACE_ENTRYPOINT_POLICY:-/usr/local/share/workspace-entrypoint/tool-settings.json}"

# take_ownership <dir>: a volume Docker creates for a path the image lacks arrives root-owned, and
# Claude Code or git then fails on a write it should have been able to make. `vscode` has
# passwordless sudo in this base image.
take_ownership() {
  if [ -d "$1" ] && [ ! -w "$1" ]; then
    warn "taking ownership of $1 (the volume arrived root-owned)"
    sudo chown -R "$(id -u):$(id -g)" "$1" 2>/dev/null || warn "chown $1 failed"
  fi
}

# The first start clones the repository into REPO_WORKSPACE, the workspace volume, over HTTPS with
# no token, since the repository is public; later pushes go through the App's credential helper,
# which runs from this clone. A start that finds a clone there, with a commit checked out, leaves it
# as it is: a session pulls. One that finds `.git` and no commit, a first start killed mid-clone,
# says so, since every step after this would otherwise skip what the clone lacks without a word.
# Fails, after a warning, when the clone cannot be made or is unfinished, and setup() then stops,
# since every step after it reads the clone. scripts/github-app-token.mjs's selftest runs it.
clone() {
  local repo="${REPO_WORKSPACE:-}" slug
  if [ -z "$repo" ]; then
    return 0
  fi
  if [ -e "$repo/.git" ]; then
    if git -C "$repo" rev-parse --verify --quiet HEAD >/dev/null; then
      return 0
    fi
    warn "$repo holds an unfinished clone, with no commit checked out -- remove the workspace volume and start again"
    return 1
  fi
  take_ownership "$repo"
  if ! slug="$(jq -er 'select([.githubRepositoryOwner, .githubRepository] | all(type == "string" and test("^[A-Za-z0-9_.-]+$"))) | "\(.githubRepositoryOwner)/\(.githubRepository)"' "$policy" 2>/dev/null)"; then
    warn "cannot clone: $policy names no githubRepositoryOwner and githubRepository -- set both in policy/tool-settings.json, then rebuild the container"
    return 1
  fi
  log "cloning https://github.com/$slug into $repo"
  if ! git clone --quiet "https://github.com/$slug.git" "$repo"; then
    warn "cloning https://github.com/$slug failed -- run \`git clone https://github.com/$slug.git $repo\` once the network is back"
    return 1
  fi
}

setup() {
  clone || return 0
  local repo="${REPO_WORKSPACE:-}"

  # Which directory under /workspaces is this repository, when REPO_WORKSPACE does not say? The one
  # whose own policy names the repository the image's copy names: a directory's name is whatever the
  # clone was made into, and the repository's name is what the project sets in
  # policy/tool-settings.json. Until 2026-09-25 this matched a package.json name, and a placeholder
  # there made every container skip setup with a warning that read like a mount problem.
  if [ -z "$repo" ]; then
    local candidate name
    name="$(jq -er '.githubRepository | strings' "$policy" 2>/dev/null)" || name=''
    for candidate in /workspaces/*/; do
      if [ -n "$name" ] && [ "$(jq -r '.githubRepository // empty' "${candidate}policy/tool-settings.json" 2>/dev/null)" = "$name" ]; then
        repo="${candidate%/}"
        break
      fi
    done
  fi

  if [ -z "$repo" ] || [ ! -d "$repo" ]; then
    warn 'workspace not found; skipping setup (set REPO_WORKSPACE if it is mounted elsewhere)'
    return 0
  fi

  cd "$repo" || return 0
  workspace="$repo"
}

# The container's `git` and `gh` act as the agents' GitHub App, through the wrappers the Dockerfile
# installs. Whether the App can mint a token is the doctor's probe, which bootstrap runs last.
credentials() {
  # A new volume takes the image's ~/.claude as it is, owned by `vscode`; one the daemon made before
  # the image had that directory arrives root-owned.
  take_ownership "$HOME/.claude"

  commit_identity
}

# ~/.gitconfig is the container's own, which a rebuild discards, so a commit made here has no
# identity until one is set. The container's sessions act as the agents' GitHub App, so whenever
# ~/.gitconfig holds no user.email, this sets user.name and user.email to the App's bot account
# (`githubAppBot*`, through `scripts/github-app-token.mjs identity`); an email already there, set by
# a person or an earlier start, is left with its name. Only those two keys are taken from the
# helper's lines. scripts/github-app-token.mjs's selftest runs this function, sourcing this file with
# ENTRYPOINT_FUNCTIONS_ONLY=1 (the end of this file).
commit_identity() {
  if [ -z "$(git config --global user.email)" ]; then
    local identity key value
    if [ -n "$workspace" ] && identity="$(cd "$workspace" && node scripts/github-app-token.mjs identity)"; then
      while IFS='=' read -r key value; do
        case "$key" in
          user.name | user.email) git config --global "$key" "$value" || warn "git config --global $key failed" ;;
        esac
      done <<<"$identity"
      if [ -n "$(git config --global user.email)" ]; then
        log "committing as $(git config --global user.name) <$(git config --global user.email)>"
      else
        warn "git identity unset: scripts/github-app-token.mjs identity gave no user.email"
      fi
    else
      warn "git identity unset, and the App's could not be read -- run \`node scripts/github-app-token.mjs identity\` in the clone to see why"
    fi
  fi

  # The clone's own .git/config outranks ~/.gitconfig, so an email set there, by a session or a person
  # in the container, is the one the container's commits carry, whatever was set above.
  if [ -n "$workspace" ] && [ -n "$(git -C "$workspace" config --local user.email)" ]; then
    warn "the clone's own .git/config sets user.email, so commits here carry $(git -C "$workspace" config --local user.email), not the App's"
  fi
}

# Claude Code's status line, run from the clone so an edit to the script needs no rebuild, set as
# `statusLine` in the volume's settings.json only while that file sets none: a status line a person
# sets in the container stays, and one deleted comes back at the next start. A file jq cannot read
# is left as it is; one missing, empty or of whitespace alone reads as `{}` through
# `first(inputs) // {}`, where `.` would print nothing and the write would empty the file. It runs
# after credentials(), which makes ~/.claude writable. scripts/github-app-token.mjs's selftest runs it.
statusline() {
  local settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" current next
  if [ -z "$workspace" ] || [ ! -f "$workspace/.devcontainer/statusline.sh" ]; then
    return 0
  fi
  current="$(cat "$settings" 2>/dev/null)"
  if printf '%s' "$current" | jq -e 'has("statusLine")' >/dev/null 2>&1; then
    return 0
  fi
  if next="$(printf '%s' "$current" | jq -n --arg command "sh '$workspace/.devcontainer/statusline.sh'" \
    'first(inputs) // {} | . + {statusLine: {type: "command", command: $command}}' 2>/dev/null)" \
    && printf '%s\n' "$next" >"$settings.tmp" && mv "$settings.tmp" "$settings"; then
    log "status line set in $settings"
  else
    rm -f "$settings.tmp"
    warn "could not set the status line in $settings -- is it valid JSON?"
  fi
}

# Every setup step a program can run, through the script the host runs too; then the doctor.
bootstrap() {
  if [ -z "$workspace" ] || [ ! -f "$workspace/scripts/bootstrap.mjs" ]; then
    return 0
  fi
  (cd "$workspace" && node scripts/bootstrap.mjs --container --warn-only) \
    || warn 'scripts/bootstrap.mjs could not run -- run `node scripts/bootstrap.mjs --container` in the clone to see why'
}

# Sourced with ENTRYPOINT_FUNCTIONS_ONLY=1, as scripts/github-app-token.mjs's selftest sources it to
# run clone, commit_identity and statusline, this file defines its functions and runs none
# of its steps.
if [ "${ENTRYPOINT_FUNCTIONS_ONLY:-}" = 1 ]; then
  return 0
fi

setup || true
credentials || true
statusline || true
bootstrap || true

# Last, so that anything above it reads as a warning about a container that is otherwise ready.
log 'ready: bd ready | mise run gates | claude'

exec "$@"
