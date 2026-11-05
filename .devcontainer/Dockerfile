# The whole "new machine setup", baked into an image.
#
# Everything a person would otherwise do by hand -- the toolchain `mise.toml` pins (Node, `bd` and
# `gh`) and Claude Code -- is a layer here rather than a devcontainer.json `feature` or
# `postCreateCommand`. That is deliberate: features resolve at
# container-create time over the network and fail differently on every machine, and a
# `postCreateCommand` re-runs on every rebuild. A layer is built once, cached, and identical for
# everyone. devcontainer.json next to this file does little but point at it.
#
# The only steps NOT in a layer are those that need the repository itself, which does not exist at
# build time: the container's own clone, in a volume, which entrypoint.sh makes at the first start
# and no host checkout is mounted over. They are the App's commit identity, read from the clone's
# policy, the status line, which runs a script in the clone, and scripts/bootstrap.mjs, which the
# host runs too: `npm ci`, the git hooks, hydrating the issue database, the plugins and installed
# skills of policy/skill-sources.json, whose project-scope install records name the clone's path,
# and the doctor. No marketplace is registered here: bootstrap registers each from that record.
# Those live in entrypoint.sh, which this file copies in and wires to ENTRYPOINT -- so the setup is
# still owned by the image, and devcontainer.json still has no lifecycle command in it.
#
# Versions are the base tag below, and `mise.toml`, whose every tool installs here through
# `mise.lock`; this file states no tool's version. The build context is the repository's
# root, so the image can read those files, and `Dockerfile.dockerignore` beside this file admits
# them, the entrypoint and the App's two wrappers, and nothing else. After a pin moves, rebuild:
# the doctor, which the entrypoint runs, warns while the image's tools lag `mise.toml`.

# The base image's major version, on its Ubuntu 24.04 codename tag. `3-noble` takes every 3.x
# release devcontainers/images publishes and never crosses a major. The codename form is the tag that
# image's manifest builds (`${VERSION}-${VARIANT}`, in its src/base-ubuntu/manifest.json). Until
# 2026-10-01 this line named `ubuntu-24.04`, a form upstream renamed (devcontainers/images#1630), and
# that tag stayed on image 2.0.5 with Git 2.51.1, older than the 2.54 that config-based hooks need.
# A major tag stops moving the same way when the next major ships, and nothing
# says so: `2-noble` has resolved to 2.1.8 since 3.0.0 shipped. So bump the major here by hand when a
# new one appears, after reading that release's history file in devcontainers/images for what it
# changes. List the majors with
# `curl -s https://mcr.microsoft.com/v2/devcontainers/base/tags/list | jq -r '.tags[]' | grep -E '^[0-9]+-noble$'`.
# Chosen by the maintainer on 2026-10-01 over `noble`, which crosses majors unasked, and over a pinned
# digest, which never moves until bumped. Read 3 there that day: image 3.0.8, Git 2.55.0.
FROM mcr.microsoft.com/devcontainers/base:3-noble

ENV DEBIAN_FRONTEND=noninteractive

# Observed on bd 1.2.2: bd sniffs terminal capability by writing OSC 11 to the tty and exiting without
# reading the reply; the terminal's answer lands in the shell's input queue and is executed as if
# typed (`11: command not found`). bd 1.3.0 still writes the query, with a DA1 after it (seen under a
# pseudo-terminal on 2026-10-06; whether it now reads the replies was not tested). NO_COLOR makes it
# skip the probe entirely. Same reason as the NO_COLOR on every bd job in git-hooks.yml -- CI=1 and
# BD_NO_COLOR=1 do not work.
#
# Set for bd alone, in the interactive shell, where a terminal answers: until 2026-10-06 this was an
# `ENV NO_COLOR=1` for every process, and Claude Code turns its color off whenever NO_COLOR is set, so
# the container's sessions had none. The gates and git hooks set it on their
# own bd calls (git-hooks.yml, tools/lib/bd-launcher.ts). A `bd` run on a tty outside an interactive
# bash, such as `devcontainer exec ... bd ready`, still probes.
RUN printf '%s\n' "alias bd='NO_COLOR=1 bd'" >>/etc/bash.bashrc

# --- base packages ------------------------------------------------------------------------------
# build-essential: some npm dependencies still compile on install. curl: the Claude Code installer
# below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        gnupg \
        jq \
        less \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# --- mise ---------------------------------------------------------------------------------------
# mise itself, at the release every workflow's `jdx/mise-action` pins, copied from mise's own image
# as its documentation does.
# The digest pins the image as the workflows' `sha256` pins their binary: a tag can be moved to
# another image, and a digest cannot. Read on 2026-10-03 from ghcr.io's manifest for the tag; when
# the tag moves, read the new one with `docker buildx imagetools inspect ghcr.io/jdx/mise:<tag>`.
COPY --from=ghcr.io/jdx/mise:2026.10.0@sha256:5253aad873240675097e6229786dff87d54a9ac9d52917e42903de37511f74b3 /usr/local/bin/mise /usr/local/bin/mise

# --- git configuration --------------------------------------------------------------------------
# safe.directory: the workspace was once a bind mount owned by the host user, and is now a
# volume the entrypoint takes ownership of before it clones. It stays, so that git still trusts the
# clone if that chown failed; otherwise git calls the whole repository untrusted and every hook fails.
# core.autocrlf input backs .gitattributes' `eol=lf` -- scripts/*.sh must stay LF or bash dies on
# an invisible carriage return.
# gc.worktreePruneExpire never: on a bind-mounted host checkout, every record of a worktree made on
# the host names a host path, so git reads each one as stale, and `git gc`, which a commit can
# start, prunes a stale record once its index is older than this, three months by default. A prune
# there unregisters the worktree on the host too. The container's clone is now its own and holds
# no host record, but the setting stays, and scripts/hooks/worktree-hooks.selftest.mjs holds it.
# The host's own git still prunes the records that are stale there.
RUN git config --system --add safe.directory '*' \
    && git config --system core.autocrlf input \
    && git config --system gc.worktreePruneExpire never

# --- workspace setup, deferred to container start ------------------------------------------------
# Bootstrap's steps, the commit identity and the status line all need the workspace, which arrives only when it is mounted, so they cannot be layers. ENTRYPOINT is how they stay in the
# image anyway: the devcontainer CLI replaces the container's *command* with a sleep, and leaves the
# image's entrypoint alone.
COPY .devcontainer/entrypoint.sh /usr/local/bin/workspace-entrypoint
RUN chmod 0755 /usr/local/bin/workspace-entrypoint

# --- the agents' GitHub App ---------------------------------------------------------------------
# The container's `git` and `gh` act as the agents' GitHub App and as nobody else.
# git's system config names `git-credential-github-app` as its helper
# for github.com, as the environment's config scope does again at the end of this file, and reads
# GitHub's two SSH address forms as HTTPS, so the tracker's Dolt remote, which runs `git` against
# `ssh://git@github.com/...`, reaches GitHub through the same helper with no SSH key. `gh` here
# stands ahead of mise's on PATH (below) and runs it with the App's token. Both run
# scripts/github-app-token.mjs from the clone, which a build cannot see, so a change to that script
# needs no rebuild and a change to either wrapper does.
COPY .devcontainer/gh .devcontainer/git-credential-github-app /usr/local/lib/github-app/bin/
RUN chmod 0755 /usr/local/lib/github-app/bin/gh /usr/local/lib/github-app/bin/git-credential-github-app \
    && git config --system --add credential.https://github.com.helper '' \
    && git config --system --add credential.https://github.com.helper /usr/local/lib/github-app/bin/git-credential-github-app \
    && git config --system --add url.https://github.com/.insteadOf ssh://git@github.com/ \
    && git config --system --add url.https://github.com/.insteadOf git@github.com:

USER vscode

# --- the toolchain `mise.toml` pins ---------------------------------------------------------------
# Every tool, as the user the container runs as, each verified against `mise.lock`: `--locked`
# refuses a tool the lock does not cover for this platform. They install under that user's home,
# which no mount covers (devcontainer.json mounts only the App's key directory, a volume at
# `~/.claude` and the workspace's volume under `/workspaces/`).
#
# The shims go on PATH through ENV, not `mise activate`, which is a shell function, as nvm is: it
# exists only in an interactive shell, and every hook, the ENTRYPOINT and `docker exec` would miss
# it. A shim takes its version from the `mise.toml` above the directory it runs in, and only a
# trusted one: devcontainer.json trusts the clone's own folder through MISE_TRUSTED_CONFIG_PATHS,
# since nothing can answer a shim's prompt to trust it, and nothing wider, so a repository cloned
# beside it under /workspaces is not trusted unasked.
#
# No global default is set, so a bare `node` in a directory with no `mise.toml` above it fails and
# says "No version is set for shim: node". Every gate runs from
# the clone, and a shim hands the real tool directories to what it starts. A selftest whose tasks run
# in a fixture repository of its own, where mise resolves `node` from the fixture's `mise.toml` and
# not from the PATH it was handed, takes one of two routes: it gives that `mise.toml` the clone's node
# pin, or it names node by its path. A global default would be a second home for the pin.
ENV PATH="/home/vscode/.local/share/mise/shims:/home/vscode/.local/bin:${PATH}"
COPY --chown=vscode:vscode mise.toml mise.lock /tmp/toolchain/
RUN MISE_TRUSTED_CONFIG_PATHS=/tmp/toolchain mise -C /tmp/toolchain install --locked \
    && MISE_TRUSTED_CONFIG_PATHS=/tmp/toolchain mise -C /tmp/toolchain exec -- \
        sh -c 'node -v && npm -v && bd --version && gh --version' \
    && rm -rf /tmp/toolchain

# --- Claude Code ---------------------------------------------------------------------------------
# Deliberately unpinned: it updates itself, so a pin here would only ever be stale. Its own installer,
# into the user's home, rather than a global npm package, which lives inside one Node install and
# would vanish when `mise.toml` moves the Node pin.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && claude --version

# The App's `gh` wrapper, copied in above, ahead of mise's shims, so a bare `gh` in the container is
# the App's. Last, because the layers above run the real `gh` at build time, which has no App key:
# `mise exec` does not put the real one ahead of a directory already first on PATH, and the
# toolchain's version check failed through the wrapper when this stood with the shims' line.
ENV PATH="/usr/local/lib/github-app/bin:${PATH}"

# The App's helper again, with its empty reset before it, in the environment's config scope, which
# git reads after every file: an empty helper drops only the helpers read before it, so in the
# system file above it drops none from `~/.gitconfig` or the clone's `.git/config`. There, a helper
# a later scope adds, such as the one VS Code writes when it attaches, would be asked once the App
# could not mint, and handed the App's token to store; here none is. The system file keeps its copy
# for a process that drops every `GIT_*` variable, as `tools/lib/git-env.ts` does for scratch
# repositories. scripts/github-app-token.mjs's selftest runs git with these lines as written here.
ENV GIT_CONFIG_COUNT=2 \
    GIT_CONFIG_KEY_0=credential.https://github.com.helper \
    GIT_CONFIG_VALUE_0="" \
    GIT_CONFIG_KEY_1=credential.https://github.com.helper \
    GIT_CONFIG_VALUE_1=/usr/local/lib/github-app/bin/git-credential-github-app

# The policy record that names the repository the entrypoint clones at the first start
# (`githubRepositoryOwner` and `githubRepository`), read from here because the clone that
# holds it does not exist yet. Last, because the record changes often and a layer above it would
# rebuild the toolchain each time. A change reaches a container once it is rebuilt.
COPY policy/tool-settings.json /usr/local/share/workspace-entrypoint/tool-settings.json

ENTRYPOINT ["/usr/local/bin/workspace-entrypoint"]
CMD ["sleep", "infinity"]
