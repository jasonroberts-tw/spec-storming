#!/bin/sh
# Claude Code's status line in the dev container: the project, its branch, the model, the effort,
# the context left, the cost and the tokens, read from the session's JSON on stdin.
# `.devcontainer/entrypoint.sh` sets it as `statusLine` in the container's settings, run from the
# clone, so an edit here needs no rebuild.
#
# The failure it exists to prevent. No incident yet. Were it wrong,
# the status line would show a stale field or none, and nothing else would notice. It reads the JSON
# with `printf`, never `echo`, which dash, the image's `sh`, runs on backslashes, so a `\n` in a JSON
# string would reach jq as a newline and leave every field empty.
#
# Invocation: `sh .devcontainer/statusline.sh < <session JSON>`, as Claude Code runs it.
#
# Needs: jq and git, which the image installs.
input=$(cat)
field() { printf '%s' "$input" | jq -r "$1"; }
project_dir=$(field '.workspace.project_dir // .cwd // ""')
root=$(basename "$project_dir")
model=$(field '.model.display_name // ""')
effort=$(field '.effort.level // empty')
remaining=$(field '.context_window.remaining_percentage // empty')
tokens=$(field '.context_window.total_input_tokens // empty')
cost=$(field '.cost.total_cost_usd // empty')

branch=""
if [ -n "$project_dir" ]; then
  branch=$(git -C "$project_dir" --no-optional-locks branch --show-current 2>/dev/null)
fi

status="$root"
[ -n "$branch" ] && status="${status} (${branch})"
[ -n "$model" ] && status="${status} | ${model}"
[ -n "$effort" ] && status="${status} | effort:${effort}"
[ -n "$remaining" ] && status="${status} | ctx:$(printf '%.0f' "$remaining")% left"
[ -n "$cost" ] && status="${status} | \$$(printf '%.2f' "$cost")"
[ -n "$tokens" ] && status="${status} | ${tokens} tok"

printf '%s' "$status"
