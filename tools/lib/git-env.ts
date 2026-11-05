/**
 * git-env.ts — a copy of this process's environment without any `GIT_*` key, for running git
 * against a tree other than this checkout; `gitIn`, which runs git in one tree with it; and
 * `SCRATCH_GIT_ENV`, the environment of a scratch repository a tool builds for itself.
 *
 * THE FAILURE IT EXISTS TO PREVENT. A hook git runs from a linked worktree inherits `GIT_DIR`, that
 * worktree's absolute git directory, and `GIT_DIR` outranks both `cwd` and `-C <dir>`. A tool that
 * builds a scratch repository and runs git in it from inside such a hook then reads or writes THIS
 * repository while claiming to read the scratch one. Agents push here from linked worktrees, and
 * `mise run gates` runs the pre-push hook there through `git hook run`, which exports the same.
 * Measured on Git 2.54.0 (Apple Git-157) and Git 2.55.0, which printed the same, on 2026-10-03, in
 * scratch repositories, through classic `.git/hooks` scripts and config-based `hook.<name>.command`
 * entries alike, for pre-commit, prepare-commit-msg, post-checkout, post-merge and pre-push:
 *   - from a linked worktree, top level or subdirectory, every one of them gets `GIT_DIR`
 *     (`<common>/.git/worktrees/<name>`), pre-commit and prepare-commit-msg also get an absolute
 *     `GIT_INDEX_FILE` (that directory's `index`), and in each hook `git -C <other>` and git run in
 *     `<other>` both answered for the worktree, not for `<other>`;
 *   - from the primary checkout, top level, subdirectory or `git -C`, none gets `GIT_DIR`,
 *     pre-commit and prepare-commit-msg get the relative `GIT_INDEX_FILE=.git/index`, and git run
 *     elsewhere answered for where it ran; and the post-checkout hook `git worktree add` runs in the
 *     new worktree got no `GIT_DIR` either;
 *   - no hook from either got `GIT_WORK_TREE`.
 * Every `GIT_*` key is dropped all the same, because an index named by an absolute path is as
 * wrong for a scratch repository as a git directory is, and a caller may set any of them. The
 * incident: on 2026-10-01 a code-graph selftest, run by the pre-push hook from a linked worktree,
 * committed its fixture onto the branch being pushed, because its git calls kept the hook's
 * `GIT_DIR`; moving them onto `gitEnv()` fixed it. `citations:selftest` asserts that
 * `gitEnv()` leaks no `GIT_*` key.
 *
 * INVOCATION. Imported, never run:
 * `import { gitEnv, gitIn, gitOk, SCRATCH_GIT_ENV, type Git } from '../lib/git-env.ts'`.
 * NEEDS. Nothing at load: it reads `process.env` and writes nothing. A function `gitIn` returns
 * needs git on the PATH when it is called.
 */
import { spawnSync } from 'node:child_process'
import { devNull } from 'node:os'

/** `process.env` without any `GIT_*` key, so git run with `cwd` or `-C` means that directory. */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  return env
}

/** A git command run in one tree: its arguments and what to feed its stdin, and what it printed on success. */
export type Git = (args: string[], input?: string) => string

/** git in `root`, with no inherited `GIT_*` key, so a hook's `GIT_DIR` cannot point it elsewhere. */
export function gitIn(root: string, env: NodeJS.ProcessEnv = gitEnv()): Git {
  return (args, input) => {
    const run = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (run.error) throw new Error(`git could not start: ${run.error.message}`)
    if (run.status !== 0) throw new Error(`\`git ${args.join(' ')}\` failed: ${(run.stderr || run.stdout).trim()}`)
    return run.stdout
  }
}

/** Whether a git command succeeds, for a question asked by its exit status alone. */
export function gitOk(git: Git, args: string[]): boolean {
  try {
    git(args)
    return true
  } catch {
    return false
  }
}

/** The environment of a scratch repository: no `GIT_*` key, and no configuration of this machine's. */
export const SCRATCH_GIT_ENV: NodeJS.ProcessEnv = { ...gitEnv(), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull }
