**This directory defines the Target project's container, including its own clone, toolchain and GitHub App credentials.**

`devcontainer.json` remains the container's launch configuration. It supplies the workspace and
credential mounts and the environment the entrypoint and wrappers read. The Dockerfile owns the
image, `scripts/bootstrap.mjs` owns Bootstrap and the entrypoint runs it; if this page and those
files disagree, those files win.

| File | Role |
|---|---|
| `devcontainer.json` | Builds the image, mounts the workspace and App key directory, and sets the container environment |
| `Dockerfile` | Installs the toolchain from `mise.toml` and `mise.lock`, Claude Code and the App wrappers |
| `Dockerfile.dockerignore` | Limits the image's build context to the files the Dockerfile reads |
| `entrypoint.sh` | Makes the container's clone at first start, sets the commit identity and status line, and runs `scripts/bootstrap.mjs --container --warn-only` at each start |
| `gh` | Runs GitHub CLI with the App's installation token |
| `git-credential-github-app` | Answers Git's credential protocol through the App token helper |
| `statusline.sh` | Prints Claude Code's status line from the clone |
| `README.md` | Explains the launch configuration and the host's key directory |

Deployment fills the named placeholders from the same values used in `policy/tool-settings.json`.
The container's workspace folder takes the repository's bare name. The App key directory on the
host is `~/.github-app/<owner>/<repository>/`, with the owner and repository filled from those
values. Create that directory before starting the container; Docker requires it to exist even
when it is empty. Put the App's one `.pem` private key there. The directory is mounted read-only
at the path `GITHUB_APP_KEY_DIR` names in `devcontainer.json`.

A project Deployed with no App has empty App keys in `policy/tool-settings.json`. Its container
still clones the repository and runs Bootstrap. Its `git` and `gh` cannot reach GitHub, so a
container session cannot push its work. Make changes on the host, where `git` and `gh` use your
own account.
