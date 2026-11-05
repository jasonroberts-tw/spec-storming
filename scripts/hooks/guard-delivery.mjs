/**
 * PreToolUse hook. Refuses the two edits the delivery workflow forbids (AGENTS.md § Delivery
 * workflow): a change to a protected test, and code written for a feature before the operator
 * approved its design at Gate 2.
 *
 * THE FAILURE THIS PREVENTS. No incident yet. Were it wrong, a session could change a test until it
 * passes, which proves nothing, or build a story on a design the operator never approved, and both
 * would surface only at review, after the work is done. The prompts carry both rules already; this is
 * the part that holds when a session forgets them.
 *
 * EACH INPUT IS READ WHERE A SESSION'S EDIT CANNOT MOVE IT. `policy/delivery.json` is read as
 * `origin/main` has it (HEAD where there is no remote), so a session cannot widen
 * `beforeApprovalPaths` or move the list by editing its own copy. A story's spec is
 * `<specDirectory>/<feature id>.md` on `origin/main`, never the tracker's `spec_id`, which a
 * session can point at another feature's approved spec.
 *
 * PROTECTED TESTS, EVERYWHERE. The list is the file `protectedTestsFile` names, one
 * `<path> <issue id>` per line, read as HEAD has it: a test is protected from the commit that lists
 * it, and a line a session drops from its working copy protects the test still. Paths compare
 * without case, since macOS and Windows open `Tests/A.mjs` for `tests/a.mjs`. The hook refuses an
 * edit to a listed path, and an edit to the list that drops or moves one of HEAD's lines. A
 * person's own editor runs no hook, so the operator approves a change by making it, or by deleting
 * the line in a commit of their own.
 *
 * GATE 2, ON AN AGENT BRANCH. A worktree named `<issue id>-<slug>` is on `agent/<issue id>-<slug>`,
 * and one `bd show` over every dash-prefix of the name finds the issue. On a feature's or an epic's
 * branch, and on a story's branch until its feature's spec on `origin/main` says `Design approved`
 * or `Shipped`, the hook refuses every path outside `beforeApprovalPaths`. Reading `origin/main`
 * means the approval is the merged design pull request, which a session's own branch cannot change.
 *
 * IT GUARDS AGAINST A SLIP, NOT AN INTENT. A session set on a change has the shell, so the hook spends
 * no calls proving the tracker's parent link or the presence of `origin/main`.
 *
 * IT FAILS OPEN, like the in-session tier it sits in (AGENTS.md § The gate ladder): with no
 * policy, no git, no `bd`, a `bd` that errors, or a branch that names no issue, it allows the edit.
 * An edit made through the shell gets past it; `spec-reviewer` diffs each protected test against the
 * commit that listed it.
 *
 *   node scripts/hooks/guard-delivery.mjs < payload.json
 *
 * Needs `git`: six calls inside a checkout, and one more for a path outside `beforeApprovalPaths`.
 * On an agent branch that path adds one call to `bd`, which the Gate 2 rule needs on PATH, and on a
 * story's branch one more to git.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { ROOT, editTargets, editedCheckout, gitEnv, readHookInput, readOr } from './_shared.mjs'

const APPROVED = /^\*\*Status:\*\*\s*(?:Design approved|Shipped)\b/m

const input = await readHookInput()
if (input === null) process.exit(0)

function git(root, ...args) {
  try {
    return execFileSync('git', args, { cwd: root, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** `policy/delivery.json` as origin/main has it, or HEAD where there is no origin/main, or null. */
function committedPolicy(root) {
  const text = git(root, 'show', 'origin/main:policy/delivery.json') ?? git(root, 'show', 'HEAD:policy/delivery.json')
  try {
    return JSON.parse(text ?? 'null')
  } catch {
    return null
  }
}

/** A list's text as a map from each protected path to the issue that protected it. */
function listed(text) {
  const map = new Map()
  for (const line of (text ?? '').split(/\r?\n/)) {
    const [path, issue = ''] = line.trim().split(/\s+/)
    if (path && !path.startsWith('#')) map.set(path.toLowerCase(), issue)
  }
  return map
}

/**
 * The list as a Write or an Edit leaves it, or null when its payload cannot say. An edit to several
 * files applies only its replacements for `filePath`, the path that named the list.
 */
function listAfter(abs, ti, filePath) {
  if (typeof ti.content === 'string') return ti.content
  const edits = Array.isArray(ti.edits)
    ? ti.edits
    : Array.isArray(ti.replacements) ? ti.replacements.filter((r) => r.file_path === filePath) : [ti]
  let text = readOr(abs)
  for (const { old_string: from, new_string: to, replace_all: all } of edits) {
    if (typeof from !== 'string' || typeof to !== 'string') return null
    const at = text.indexOf(from)
    if (at === -1) continue
    text = all ? text.split(from).join(to) : text.slice(0, at) + to + text.slice(at + from.length)
  }
  return text
}

/** HEAD's paths a Codex patch takes out of the list, or null when it deletes, moves or overwrites the list wholesale. */
function patchDrops(listPath, head) {
  // Resolved as `editTargets` resolves a patch's paths, so the two cannot disagree about which is the list.
  const isList = (path) => resolve(input.cwd ?? ROOT, path).toLowerCase() === listPath.toLowerCase()
  const removed = new Set()
  const added = new Set()
  let inList = false
  let rewrite = false
  for (const line of String(input.tool_input?.command ?? '').split(/\r?\n/)) {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (file) {
      inList = isList(file[2])
      if (inList && file[1] === 'Delete') return null
      rewrite ||= inList && file[1] === 'Add'
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move && (inList || isList(move[1]))) return null
    if (!inList || line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('-')) for (const path of listed(line.slice(1)).keys()) removed.add(path)
    if (line.startsWith('+')) for (const path of listed(line.slice(1)).keys()) added.add(path)
  }
  return [...(rewrite ? head.keys() : removed)].filter((path) => !added.has(path))
}

function refuse(lines) {
  process.stderr.write(lines.join('\n'))
  process.exit(2)
}

/** The issue an `agent/<issue id>-<slug>` branch carries, from `bd show`, or null. */
function branchIssue(root) {
  const branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD')?.trim() ?? ''
  if (!branch.startsWith('agent/')) return null
  const words = branch.slice('agent/'.length).split('-')
  const candidates = words.map((_, i) => words.slice(0, i + 1).join('-'))
  // ponytail: one bd call per code edit on an agent branch, about 0.4 s; cache the answer in
  // .worktree/ if sessions feel it.
  const r = spawnSync('bd', ['show', '--json', '--', ...candidates], {
    cwd: root, env: { ...gitEnv(), NO_COLOR: '1' }, encoding: 'utf8', timeout: 10000,
  })
  if (r.status !== 0) return null
  try {
    const found = [].concat(JSON.parse(r.stdout)).filter((issue) => candidates.includes(issue?.id))
    return found.sort((a, b) => b.id.length - a.id.length)[0] ?? null
  } catch {
    return null
  }
}

for (const { filePath } of editTargets(input)) {
  const target = editedCheckout(filePath)
  if (target === null) continue
  const { root, rel } = target
  const policy = committedPolicy(root)
  if (!policy) continue
  const listFile = policy.protectedTestsFile
  const protectedPaths = typeof listFile === 'string' ? listed(git(root, 'show', `HEAD:${listFile}`)) : new Map()

  if (protectedPaths.has(rel.toLowerCase())) {
    refuse([
      `${rel} is a protected test, listed in ${listFile} for ${protectedPaths.get(rel.toLowerCase()) || 'its issue'}.`,
      '',
      'Never modify, weaken, skip or delete it. If it or the contract behind it looks wrong, stop, say',
      'why, and wait: the operator changes it, or approves the change by deleting its line in a commit',
      'of their own (AGENTS.md § Delivery workflow).',
    ])
  }
  if (rel.toLowerCase() === listFile.toLowerCase() && protectedPaths.size > 0) {
    const patch = input.tool_name === 'apply_patch'
    const after = patch ? null : listAfter(join(root, rel), input.tool_input ?? {}, filePath)
    const dropped = patch
      ? patchDrops(filePath, protectedPaths)
      : after === null ? [] : [...protectedPaths.keys()].filter((path) => !listed(after).has(path))
    if (dropped === null || dropped.length > 0) {
      refuse([
        `This edit drops ${dropped === null ? 'every protected test' : dropped.join(', ')} from ${listFile}.`,
        '',
        'Only the operator lifts a protection. Add lines to the list, and ask the operator to delete',
        'one (AGENTS.md § Delivery workflow).',
      ])
    }
  }

  const open = (Array.isArray(policy.beforeApprovalPaths) ? policy.beforeApprovalPaths : []).filter(
    (prefix) => typeof prefix === 'string' && prefix.endsWith('/') && prefix.length > 1,
  )
  if (open.some((prefix) => rel.startsWith(prefix))) continue
  const issue = branchIssue(root)
  if (issue === null) continue
  if (issue.issue_type === 'feature' || issue.issue_type === 'epic') {
    refuse([
      `This branch carries ${issue.issue_type} ${issue.id}, and ${rel} is outside ${open.join(', ')}.`,
      '',
      `A ${issue.issue_type}'s branch holds its spec and decision records. Code goes in a story under the`,
      'feature, on its own branch, once the operator approves the design (the `plan-stories` skill).',
    ])
  }
  const feature = (issue.dependencies ?? []).find(
    (dep) => dep?.dependency_type === 'parent-child' && dep.issue_type === 'feature',
  )
  if (issue.issue_type !== 'task' || !feature) continue
  const specPath = `${policy.specDirectory}/${feature.id}.md`
  const spec = typeof policy.specDirectory === 'string' ? git(root, 'show', `origin/main:${specPath}`) : null
  if (spec === null || !APPROVED.test(spec)) {
    const status = /^\*\*Status:\*\*\s*(.*)$/m.exec(spec ?? '')?.[1]?.trim()
    refuse([
      `Story ${issue.id} belongs to feature ${feature.id}, whose spec on origin/main ` +
        (spec === null ? `does not exist (${specPath})` : `says ${status ? `"${status}"` : 'no status'}`) +
        '.',
      '',
      `No implementation code is written before the operator approves the design at Gate 2 (the`,
      '`design` skill), and approval is the spec on origin/main saying `Design approved`. If it',
      'merged after this branch was cut, run `git fetch origin main` and rebase; otherwise stop and',
      `report. ${open.join(', ')} stay writable.`,
    ])
  }
}

process.exit(0)
