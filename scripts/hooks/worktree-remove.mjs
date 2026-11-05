/**
 * WorktreeRemove hook. The teardown half of scripts/hooks/worktree-create.mjs.
 *
 * THE DEFECT THIS PREVENTS: worktrees that cannot be removed and so are never removed. Two of them
 * were found registered days after their work had landed, and the reason they survived was not
 * neglect -- `git worktree remove` fails inside the agent sandbox:
 *
 *     error: failed to delete '.git/worktrees/<name>': Device or resource busy
 *
 * The sandbox's bind mounts hold the admin directory open, so the removal an exiting agent attempts
 * cannot succeed, and the same run leaves a read-only `.git/config.lock` behind that then blocks
 * every later `git config` write. Both are worked around below. Without a hook the harness falls
 * back to plain `git worktree remove` and inherits the whole failure.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: delete the branch. `git worktree remove` only ever removes a
 * checkout, and the branch is the work. AGENTS.md § Git workflow routes a worktree's branch to trunk
 * through a pull request, which means the branch outliving its worktree is the normal case, not a
 * leak. Deleting it here would discard unpushed commits at session exit -- silently, since nothing
 * reads a hook's stdout on the remove path.
 *
 * Every message goes to STDERR. The harness reads this hook's stdout, and
 * worktree-hooks.selftest.mjs asserts it stays empty.
 *
 * CONTRACT (verified against the CLI, 2.1.241). stdin is JSON:
 *   { "hook_event_name": "WorktreeRemove", "worktree_path": "<absolute path>", ... }
 * Exit zero once the worktree is gone. The harness checks the path afterwards and warns
 * "WorktreeRemove hook did not remove worktree, kept at: ..." if it is still there, so a zero exit
 * over a failed removal buys nothing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** Best-effort git, on stderr. Every caller below has a fallback, so a failure is not fatal. */
function git(args) {
  try {
    execFileSync('git', ['-C', ROOT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

const raw = await readStdin()
let input
try {
  input = JSON.parse(raw)
} catch {
  console.error(`WorktreeRemove: stdin was not JSON (${raw.slice(0, 120)})`)
  process.exit(1)
}

const worktreePath = input.worktree_path
if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
  console.error('WorktreeRemove: no worktree_path on stdin')
  process.exit(1)
}

// A stale read-only lock left by an earlier sandboxed run makes every git write below fail with
// "could not lock config file". It is a zero-byte file with no process behind it by the time a
// removal runs, so clearing it is safe and is the difference between this hook working and not.
const configLock = join(ROOT, '.git', 'config.lock')
try {
  if (existsSync(configLock)) {
    unlinkSync(configLock)
    console.error('WorktreeRemove: cleared a stale .git/config.lock')
  }
} catch {
  /* not fatal; the removal below may still succeed */
}

// Whether the path removed is one this repository provisions, inside `<ROOT>/.claude/worktrees/`.
// A foreign path means this hook is being exercised rather than used, and nothing of this
// repository's is touched for one: no admin directory.
const OWNED_DIR = join(ROOT, '.claude', 'worktrees') + sep
const owned = resolve(worktreePath).startsWith(OWNED_DIR)

/**
 * The admin directory the worktree's `.git` file names, or `null`. Not `.git/worktrees/<basename>`:
 * git adds a number to that name on a collision, so it can be another worktree's record. And not the
 * `.git` file's word alone, which anything in the worktree can rewrite: the directory must sit
 * directly under ROOT's `.git/worktrees/` and its own `gitdir` must name this worktree back, the
 * two-way link git keeps.
 */
function adminDirOf(path) {
  try {
    const match = /^gitdir: (.+)$/m.exec(readFileSync(join(path, '.git'), 'utf8'))
    if (match === null) return null
    const admin = resolve(path, match[1].trim())
    if (dirname(admin) !== join(ROOT, '.git', 'worktrees')) return null
    const back = resolve(admin, readFileSync(join(admin, 'gitdir'), 'utf8').trim())
    return realpathSync(back) === realpathSync(join(path, '.git')) ? admin : null
  } catch {
    return null
  }
}

// The ordinary path first. It is the only one that also tidies the admin directory by itself.
let removed = git(['worktree', 'remove', '--force', worktreePath])

// The sandbox path. `git worktree remove` refused because something holds `.git/worktrees/<name>`
// open, so the checkout and, for a path this repository owns, the admin directory are removed
// directly; a record left behind shows as prunable in `git worktree list`. `rmSync` succeeds where
// git's own unlink loop gives up.
if (!removed) {
  console.error(`WorktreeRemove: git worktree remove failed for ${worktreePath}; removing directly`)
  try {
    const admin = owned ? adminDirOf(worktreePath) : null
    rmSync(worktreePath, { recursive: true, force: true })
    if (admin !== null) rmSync(admin, { recursive: true, force: true })
    removed = true
  } catch (err) {
    console.error(`WorktreeRemove: direct removal failed: ${err.message}`)
  }
}

// NO `git worktree prune` HERE, and the incident that took it out. This hook ran one on `ROOT` on
// every call, before the ownership check, so each run of its selftest, then a pre-push job, pruned
// the real repository through that suite's foreign-path cases. On a host that took only records
// whose worktree was gone. On 2026-10-06 a dev container on the bind-mounted primary checkout pushed,
// and there every record names a host path the container cannot see: git read each as stale,
// pruned them all, and git and bd stopped working in every linked worktree on the host. The same
// suite's foreign path also named the admin directory of a live worktree that shared its last
// name, hence `owned` above. A stale record is left for a person's `git worktree prune`.

if (existsSync(worktreePath)) {
  console.error(`WorktreeRemove: ${worktreePath} still exists`)
  process.exit(1)
}
console.error(`WorktreeRemove: removed ${worktreePath}`)
