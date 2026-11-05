/**
 * WorktreeCreate hook. Makes the Claude Code `EnterWorktree` tool provision worktrees through
 * `scripts/new-worktree.sh` instead of creating its own.
 *
 * THE DEFECT THIS PREVENTS: two unrelated ways to get a worktree in one repository. What the harness
 * tool and the script disagree about, after the script was moved to the tool's own location:
 *
 *   |            | new-worktree.sh              | EnterWorktree, unhooked                  |
 *   |------------|------------------------------|------------------------------------------|
 *   | location   | .claude/worktrees/<name>     | .claude/worktrees/<name> -- AGREE        |
 *   | base       | origin/main, fetched first   | worktree.baseRef: origin/<default>, HEAD |
 *   | branch     | agent/<name>                 | worktree-<name>                          |
 *   | ports      | probed, written to ports.env | none; every agent binds the same         |
 *   | briefing   | .worktree/CONTEXT.md         | none; AGENTS.md's @-import is dead       |
 *
 * LOCATION USED TO BE THE FIRST ROW AND IS NOW SETTLED. The script provisioned outside the working
 * tree at `../worktrees/<name>` and the tool insisted on `.claude/worktrees/<name>`, so the two
 * fought over every worktree; the repository now accepts the tool's location and the script follows
 * it. The hazard that argued for staying outside is real but is handled by a different mechanism: a
 * checkout inside the working tree carries its own `.git`, reads to the parent as a gitlink, and can
 * be committed as a phantom submodule by a sweeping `git add` -- which is what one commit did to both
 * trunks. `.gitignore` covers `.claude/worktrees/`, and that rule is what makes the shared location
 * safe. Two further benefits fell out of agreeing: `EnterWorktree` can switch into a worktree it
 * recognises, which it refuses for any path outside `.claude/worktrees/`, and there is no longer a
 * placement an agent can reach by accident.
 *
 * What is left is the base, the branch and the briefing, and the base is why no setting will do.
 * AGENTS.md § Git workflow cuts agent work from `origin/main` by the one worktree script, and
 * `worktree.baseRef` offers only `fresh` (origin/<default branch>) or `head`, so no setting
 * expresses "origin/main". The default branch is a GitHub setting outside this repository: `main`
 * when checked on 2026-09-23, and free to change without a commit here. A hook names the trunk
 * itself. When this hook does NOT run, the fallback is silent and the branch name is the only
 * surviving evidence, which is what `guard-unprovisioned-worktree.mjs` keys its tripwire on.
 *
 * CONTRACT (verified against the CLI, 2.1.241). stdin is JSON:
 *   { "hook_event_name": "WorktreeCreate", "name": "<worktree name>", "cwd": ..., "session_id": ... }
 * The hook must CREATE the directory and print its path as the last line of stdout. Everything else
 * -- every diagnostic, every line new-worktree.sh prints -- must go to stderr, or the harness reads
 * it as the path. A configured hook takes precedence over the native git path even inside a git
 * repository, so this file is the only worktree provisioner once it is wired up.
 */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Read all of stdin. The harness closes it, so this terminates. */
async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * A worktree name becomes a directory name and a branch name, so it cannot contain a path separator
 * or a dot segment. The harness rejects dot segments in what the hook RETURNS; nothing stops them
 * arriving in what it is GIVEN, and `..` in a name would place the worktree outside WORKTREE_ROOT.
 */
function validName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.split(/[-.]/).includes('..') &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    name !== '.' &&
    name !== '..'
  )
}

const raw = await readStdin()
let input
try {
  input = JSON.parse(raw)
} catch {
  console.error(`WorktreeCreate: stdin was not JSON (${raw.slice(0, 120)})`)
  process.exit(1)
}

const name = input.name
if (!validName(name)) {
  console.error(
    `WorktreeCreate: refusing the name ${JSON.stringify(name)}. ` +
      'It becomes a directory and a branch, so it must be a single path segment of letters, digits, ' +
      'dot, dash or underscore.',
  )
  process.exit(1)
}

// new-worktree.sh prints the human summary on stdout. That stream is the return channel here, so it
// is redirected wholesale to stderr -- where the operator still sees it in the hook's output -- and
// the only thing this file writes to stdout is the path, last.
let summary
try {
  summary = execFileSync('bash', [join(ROOT, 'scripts', 'new-worktree.sh'), name], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
} catch (err) {
  console.error(`WorktreeCreate: scripts/new-worktree.sh failed for ${name}`)
  if (err.stdout) console.error(err.stdout)
  process.exit(1)
}
console.error(summary.trimEnd())

// Parse the path back out of the summary rather than recomputing it, so this file cannot drift from
// the script's own idea of where a worktree lives (WORKTREE_ROOT is overridable).
const match = /^worktree: (.+)$/m.exec(summary)
if (!match) {
  console.error('WorktreeCreate: new-worktree.sh printed no "worktree: <path>" line')
  process.exit(1)
}
const worktreePath = match[1].trim()

// The harness fails with a confusing message if the path is not a directory. Checking here names the
// real culprit instead.
try {
  if (!statSync(worktreePath).isDirectory()) throw new Error('not a directory')
} catch {
  console.error(`WorktreeCreate: ${worktreePath} is not a directory after provisioning`)
  process.exit(1)
}

process.stdout.write(`${worktreePath}\n`)
