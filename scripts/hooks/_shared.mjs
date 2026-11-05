/**
 * Shared helpers for the CLI command hooks in this directory.
 *
 * These hooks run on EVERY matching tool call, so the budget is a few hundred milliseconds. This file
 * imports Node's built-in `fs`, `path`, `url` and `child_process` and nothing else, and it reads no
 * file and starts no process when it is loaded. Two helpers start a process, and only when called:
 * `checkoutOf` runs git, and `editedCheckout` runs it through `checkoutOf`. A hook that calls neither
 * starts none.
 *
 * Why this tier exists: most of the work in this
 * repository is done by an agent, and a gate that fires after the agent has spent twenty minutes
 * going the wrong way is worth far less than one that stops it at the first keystroke.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/** The repository root. This file lives at `scripts/hooks/_shared.mjs`. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * The repository's trunk -- the branch checked out in the primary worktree, the base every agent
 * branch is cut from, and the target of every pull request. Renaming trunk is this one line rather
 * than a dozen scattered string literals, and the only reason a rename is cheap is that it is named
 * once: `guard-git.mjs`, `guard-unprovisioned-worktree.mjs` and `scripts/doctor.mjs` import it.
 */
export const TRUNK = 'main'

/**
 * Read the hook payload from stdin.
 *
 * Returns `null` rather than hanging when there is no stdin, so every hook in this directory can be
 * run by hand and exits cleanly with nothing to do.
 */
export async function readHookInput() {
  if (process.stdin.isTTY) return null
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return null
  try {
    return claudeFields(JSON.parse(text))
  } catch {
    return null
  }
}

/**
 * Every name a hook payload gives a tool that writes files: Claude's, which GitHub Copilot CLI's
 * Claude-compatible payload uses too; the patch tool Codex and VS Code share; and VS Code's own.
 * VS Code's Local agent ignores `matcher` and runs every hook for every tool, so its reads reach the
 * edit guards too, and a `read_file` of a protected test must not count as an edit to it. A tool
 * missing here is never judged an edit.
 */
const EDIT_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'apply_patch',
  'create_file', 'replace_string_in_file', 'multi_replace_string_in_file', 'insert_edit_into_file', 'edit_notebook_file',
])

/** One edit's arguments in Claude's names, each filled from Copilot CLI's or VS Code's when absent. */
function claudeArgs(args) {
  return {
    ...args,
    file_path: args.file_path ?? args.path ?? args.filePath,
    content: args.content ?? args.file_text,
    old_string: args.old_string ?? args.old_str ?? args.oldString,
    new_string: args.new_string ?? args.new_str ?? args.newString,
  }
}

/**
 * The payload in the field names these hooks read.
 *
 * Copilot CLI's Claude-compatible payload gives Claude's tool names with Copilot's argument names,
 * and calls a patch `Edit`. VS Code gives its own tool names with `filePath`, `oldString` and
 * `newString`, a list of `replacements` for an edit to several files, and a patch's text in `input`.
 * Read as they come, those edits name no file, and every edit guard lets them through. So each
 * edit's arguments take Claude's names (`claudeArgs`), and patch text becomes the `apply_patch`
 * payload Codex sends. A Claude or Codex payload reads as it did before.
 */
function claudeFields(input) {
  if (input === null || typeof input !== 'object' || !EDIT_TOOLS.has(input.tool_name)) return input
  const ti = input.tool_input
  const patch = typeof ti === 'string' ? ti : ti?.command ?? ti?.input ?? ti?.patch
  if (typeof patch === 'string' && patch.trimStart().startsWith('*** Begin Patch')) {
    return { ...input, tool_name: 'apply_patch', tool_input: { command: patch } }
  }
  if (ti === null || typeof ti !== 'object') return input
  const args = claudeArgs(ti)
  if (Array.isArray(ti.replacements)) {
    args.replacements = ti.replacements.filter((r) => r !== null && typeof r === 'object').map(claudeArgs)
  }
  return { ...input, tool_input: args }
}

/**
 * The files an edit tool's call writes, each with the text it writes there, or none for any other
 * tool.
 *
 * `tool_input.file_path` is the documented field; the text is `content` on Write, `new_string` on
 * Edit, and `code` on VS Code's `insert_edit_into_file`. The text is read because a Write to a path
 * that does not exist yet has no file on disk to inspect, and the incoming TEXT is then the only
 * evidence available. VS Code's `multi_replace_string_in_file` names a file in each replacement.
 */
export function editTargets(input) {
  const ti = input?.tool_input ?? {}
  if (!EDIT_TOOLS.has(input?.tool_name)) return []
  if (input.tool_name !== 'apply_patch') {
    return (Array.isArray(ti.replacements) ? ti.replacements : [ti]).map((args) => ({
      filePath: typeof args.file_path === 'string' ? args.file_path : null,
      text: [args.content, args.new_string, args.code].find((t) => typeof t === 'string') ?? '',
    }))
  }
  // Codex sends a patch in tool_input.command, as `claudeFields` puts Copilot's. Every source and
  // move destination is an edit.
  const targets = []
  let current
  for (const line of (typeof ti.command === 'string' ? ti.command : '').split(/\r?\n/)) {
    const match = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(line)
    if (match) {
      current = { filePath: resolve(input.cwd ?? ROOT, match[1]), text: '' }
      targets.push(current)
    } else if (current && line.startsWith('+')) {
      current.text += line.slice(1) + '\n'
    }
  }
  return targets
}

/**
 * A POSIX path relative to the checkout at `root`, this one unless the caller names another, or `null`
 * when the target is outside it.
 */
export function toRepoRel(filePath, root = ROOT) {
  if (typeof filePath !== 'string' || filePath === '') return null
  const rel = relative(root, resolve(root, filePath))
  if (rel === '' || rel.startsWith('..')) return null
  return rel.split(sep).join('/')
}

/**
 * The first 2,000 bytes of a file -- its header and nothing else.
 *
 * The window matters. An emitter contains the literal string "GENERATED ... DO NOT EDIT BY HAND"
 * because it EMITS it. A whole-file search would classify every emitter as generated output and refuse
 * every edit to the only files that can actually fix anything.
 */
export function header(absPath) {
  try {
    const fd = openSync(absPath, 'r')
    try {
      const buf = Buffer.alloc(2000)
      const n = readSync(fd, buf, 0, 2000, 0)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * Does this text carry a generator's own hands-off banner in its header?
 *
 * BOTH SIGNALS ON THE SAME LINE, which is not fussiness. Every real banner in this repository is one
 * shouted line naming the tool and forbidding the edit in the same breath. Testing the two halves
 * against the whole header instead flags any FILE THAT DISCUSSES build products: it flagged
 * a script whose entire subject is this check.
 *
 * A banner split over two lines slips past this, so a generator that writes one is not refused.
 */
export function hasGeneratedBanner(text) {
  // Two separate patterns, applied line by line, so no line of THIS file carries both halves and
  // trips the check on itself.
  const namesATool = /\bgenerated\b/i
  const forbidsTheEdit = /do not (?:edit by hand|hand-edit)/i
  return text
    .slice(0, 2000)
    .split('\n')
    .some((line) => namesATool.test(line) && forbidsTheEdit.test(line))
}

/**
 * Is the content heuristic even worth running on this path?
 *
 * NOT ON PROSE. A document that quotes the banner in order to explain it is normal and expected,
 * and the heuristic once refused to let such a document be edited. So the check covers code and data
 * only, and generated Markdown goes unguarded.
 */
export function bannerCheckApplies(rel) {
  return !/\.(?:md|mdx|txt|rst|adoc)$/i.test(rel)
}

/* ============================================================================================= *
 * Which checkout an edit lands in.
 * ============================================================================================= */

/**
 * This process's environment without any `GIT_*` key, so git answers for the directory it runs in.
 * A hook inherits its session's environment, and an inherited `GIT_DIR` outranks `cwd`: with no
 * `GIT_WORK_TREE` git takes `cwd` for the top of the work tree, so `editedCheckout` would place an
 * edit in the edited file's own directory rather than in its checkout (a branch review found this
 * before it merged). `guard-git.mjs` runs its git through it too. The same function is `gitEnv` in
 * `tools/lib/git-env.ts`; it is not imported, because this file imports Node's built-ins only and
 * the selftests run a copy of it alone.
 */
export function gitEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
  return env
}

/** An absolute path `git rev-parse` gives for `flag` in `dir`, resolved, or null outside a checkout. */
function gitPath(dir, flag) {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', flag], {
      cwd: dir,
      env: gitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return realpathSync(out.trim())
  } catch {
    return null
  }
}

/**
 * The top of the checkout `cwd` is in, when that checkout is `ownRoot`'s repository (the primary
 * checkout or a linked worktree, which share one git directory), and `ownRoot` otherwise: no `cwd`,
 * a `cwd` outside any checkout, or one in another repository. One git call with no `cwd`, two when
 * `cwd` is outside any checkout, and four when it is inside one.
 */
export function checkoutOf(cwd, ownRoot = ROOT) {
  const own = gitPath(ownRoot, '--show-toplevel') ?? ownRoot
  if (typeof cwd !== 'string' || cwd === '') return own
  const top = gitPath(cwd, '--show-toplevel')
  if (top === null) return own
  const theirs = gitPath(cwd, '--git-common-dir')
  const ours = gitPath(ownRoot, '--git-common-dir')
  return theirs !== null && theirs === ours ? top : own
}

/**
 * The checkout of this repository an edit to `filePath` lands in, placed by the path itself, and the
 * path relative to it: `{ root, rel }`, or `null` when the path is in no checkout of this repository.
 * Never by the payload's `cwd`: a session in a worktree can edit the primary checkout's files too.
 * A relative path resolves against `ownRoot`, as in `toRepoRel`. The nearest of its directories that
 * exists places it, since a Write may make the file's directory and git answers only in one that
 * exists; and it is compared in its real form, the form `checkoutOf` gives a checkout's top in.
 * Starts git through `checkoutOf`: four calls inside a checkout, two outside any.
 */
export function editedCheckout(filePath, ownRoot = ROOT) {
  if (typeof filePath !== 'string' || filePath === '') return null
  const abs = resolve(ownRoot, filePath)
  let dir = dirname(abs)
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const root = real(checkoutOf(dir, ownRoot))
  const rel = toRepoRel(join(real(dir), relative(dir, abs)), root)
  return rel === null ? null : { root, rel }
}

/** Read a file, or a fallback. */
export function readOr(absPath, fallback = '') {
  try {
    return readFileSync(absPath, 'utf8')
  } catch {
    return fallback
  }
}
