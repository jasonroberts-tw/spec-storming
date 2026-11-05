/**
 * The delivery guard, negative-tested: `guard-delivery.mjs` run as the harness runs it, over a scratch
 * repository with a stub `bd`, one broken thing per case, beside controls that must pass.
 *
 * THE FAILURE THIS PREVENTS. No incident yet. Were it missing, the guard could stop refusing a change
 * to a protected test, or let a story write code before its feature's design was approved, and every
 * commit and push would still pass, because the hook fails open and nothing else runs it.
 *
 * The hook judges only files in its own repository, so the hook, `_shared.mjs` and the live
 * `policy/delivery.json` are copied into the scratch repository and run from there: that copy is this
 * selftest's root override. The stub `bd` prints the file `STUB_BD_OUT` names and logs its arguments,
 * so the cases need no tracker and show which ids the hook asked for.
 *
 *   mise run guard-delivery:selftest      (node scripts/hooks/guard-delivery.selftest.mjs)
 *
 * Needs `git` and a POSIX `sh` for the stub. It writes only under the temporary directory.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS = dirname(fileURLToPath(import.meta.url))
const POLICY = JSON.parse(readFileSync(resolve(HOOKS, '..', '..', 'policy', 'delivery.json'), 'utf8'))
const LIST = POLICY.protectedTestsFile
let failures = 0

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
    failures += 1
  }
}

// Every GIT_* variable dropped and no personal config read, so a run from a pre-push hook cannot
// reach the real repository (`worktree-hooks.selftest.mjs` has the incident).
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}
const AS = ['-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest']
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const commit = (cwd, message) => {
  git(cwd, 'add', '-A')
  git(cwd, ...AS, 'commit', '-qm', message)
  return git(cwd, 'rev-parse', 'HEAD').trim()
}

const scratch = mkdtempSync(join(tmpdir(), 'guard-delivery-'))
const primary = join(scratch, 'primary')
const bin = join(scratch, 'bin')
const bdOut = join(scratch, 'bd-out.json')
const bdLog = join(scratch, 'bd-args.log')
const HOOK = join(primary, 'scripts', 'hooks', 'guard-delivery.mjs')

try {
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: GIT_ENV })
  for (const file of ['_shared.mjs', 'guard-delivery.mjs']) {
    mkdirSync(join(primary, 'scripts', 'hooks'), { recursive: true })
    copyFileSync(join(HOOKS, file), join(primary, 'scripts', 'hooks', file))
  }
  write(join(primary, 'policy', 'delivery.json'), JSON.stringify(POLICY, null, 2))
  write(join(primary, LIST), '# protected tests\ntests/a.test.mjs demo-x1.1.1\n')
  write(join(primary, 'tests', 'a.test.mjs'), 'test a\n')
  write(join(primary, 'tests', 'b.test.mjs'), 'test b\n')
  write(join(primary, 'src', 'x.mjs'), 'x\n')
  write(join(primary, 'docs', 'specs', 'demo-x1.1.md'), '# Feature\n\n**Status:** Intent confirmed 2026-10-16\n')
  const intent = commit(primary, 'init')
  write(join(primary, 'docs', 'specs', 'demo-x1.1.md'), '# Feature\n\n**Status:** Design approved 2026-10-16\n')
  const approved = commit(primary, 'approve')
  git(primary, 'reset', '-q', '--hard', intent)

  mkdirSync(bin)
  write(join(bin, 'bd'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$STUB_BD_LOG"\ncat "$STUB_BD_OUT"\nexit "${STUB_BD_STATUS:-0}"\n')
  chmodSync(join(bin, 'bd'), 0o755)

  const run = (payload, { bd = null, status = 0, path = `${bin}${delimiter}${process.env.PATH}` } = {}) => {
    write(bdLog, '')
    if (bd !== null) write(bdOut, JSON.stringify(bd))
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      cwd: scratch,
      env: { ...GIT_ENV, PATH: path, STUB_BD_OUT: bdOut, STUB_BD_LOG: bdLog, STUB_BD_STATUS: String(status) },
      encoding: 'utf8',
    })
    return { code: r.status ?? 1, stderr: r.stderr ?? '', bdArgs: readFileSync(bdLog, 'utf8').trim() }
  }
  const edit = (file, from = 'x', to = 'y') => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string: from, new_string: to } })
  const why = (r) => `code=${r.code} ${JSON.stringify(r.stderr.slice(0, 160))}`
  const refusedFor = (r, reason) => r.code === 2 && r.stderr.includes(reason)
  const PROTECTED = 'is a protected test'
  const DROPS = 'This edit drops'

  console.log('guard-delivery: protected tests')
  const control = run(edit(join(primary, 'src', 'x.mjs')))
  check('control: an edit to an unlisted file on main is allowed', control.code === 0, why(control))
  const listedEdit = run(edit(join(primary, 'tests', 'a.test.mjs')))
  check('an edit to a test HEAD lists is refused', refusedFor(listedEdit, PROTECTED), why(listedEdit))
  const cased = run(edit(join(primary, 'Tests', 'A.test.mjs')))
  check('a listed test named in another case is refused', refusedFor(cased, PROTECTED), why(cased))
  const unlisted = run(edit(join(primary, 'tests', 'b.test.mjs')))
  check('an edit to a test HEAD does not list is allowed', unlisted.code === 0, why(unlisted))
  write(join(primary, LIST), '# protected tests\ntests/b.test.mjs demo-x1.1.1\n')
  const workingOnly = run(edit(join(primary, 'tests', 'a.test.mjs')))
  check('a line dropped from the working copy protects its test still', refusedFor(workingOnly, PROTECTED), why(workingOnly))
  const notYet = run(edit(join(primary, 'tests', 'b.test.mjs')))
  check('a line added but not committed protects nothing yet', notYet.code === 0, why(notYet))
  git(primary, 'checkout', '-q', '--', LIST)
  const listPath = join(primary, LIST)
  const append = run(edit(listPath, 'demo-x1.1.1\n', 'demo-x1.1.1\ntests/b.test.mjs demo-x1.1.2\n'))
  check('an edit that adds a line to the list is allowed', append.code === 0, why(append))
  const dropEdit = run(edit(listPath, 'tests/a.test.mjs demo-x1.1.1\n', ''))
  check('an edit that drops a listed line is refused', refusedFor(dropEdit, DROPS), why(dropEdit))
  const dropWrite = run({ tool_name: 'Write', tool_input: { file_path: listPath, content: '# protected tests\n' } })
  check('a write that drops a listed line is refused', refusedFor(dropWrite, DROPS), why(dropWrite))
  const patchTest = run({
    tool_name: 'apply_patch', cwd: primary,
    tool_input: { command: '*** Begin Patch\n*** Update File: tests/a.test.mjs\n-test a\n+test A\n*** End Patch\n' },
  })
  check('a Codex patch to a listed test is refused', refusedFor(patchTest, PROTECTED), why(patchTest))
  const patchList = run({
    tool_name: 'apply_patch', cwd: primary,
    tool_input: { command: `*** Begin Patch\n*** Update File: ${LIST}\n-tests/a.test.mjs demo-x1.1.1\n*** End Patch\n` },
  })
  check('a Codex patch that drops a listed line is refused', refusedFor(patchList, DROPS), why(patchList))
  const patchMove = run({
    tool_name: 'apply_patch', cwd: primary,
    tool_input: { command: `*** Begin Patch\n*** Update File: ${LIST}\n*** Move to: docs/elsewhere.txt\n*** End Patch\n` },
  })
  check('a Codex patch that moves the list away is refused', refusedFor(patchMove, DROPS), why(patchMove))
  const patchOnto = run({
    tool_name: 'apply_patch', cwd: primary,
    tool_input: { command: `*** Begin Patch\n*** Update File: docs/other.txt\n*** Move to: ${LIST}\n*** End Patch\n` },
  })
  check('a Codex patch that moves another file onto the list is refused', refusedFor(patchOnto, DROPS), why(patchOnto))
  const patchAddOver = run({
    tool_name: 'apply_patch', cwd: primary,
    tool_input: { command: `*** Begin Patch\n*** Add File: ${LIST}\n+# protected tests\n*** End Patch\n` },
  })
  check('a Codex patch that adds the list afresh without its lines is refused', refusedFor(patchAddOver, DROPS), why(patchAddOver))
  const patchDotted = run({
    tool_name: 'apply_patch', cwd: primary,
    tool_input: { command: `*** Begin Patch\n*** Update File: ${LIST.replace('/', '/./')}\n-tests/a.test.mjs demo-x1.1.1\n*** End Patch\n` },
  })
  check('a Codex patch that names the list by a dotted path is read as the list', refusedFor(patchDotted, DROPS), why(patchDotted))
  const patchAdd = run({
    tool_name: 'apply_patch', cwd: primary,
    tool_input: { command: `*** Begin Patch\n*** Update File: ${LIST}\n+tests/b.test.mjs demo-x1.1.2\n*** End Patch\n` },
  })
  check('a Codex patch that adds a line is allowed', patchAdd.code === 0, why(patchAdd))
  // Copilot's Claude-compatible payload: Claude's tool names, Copilot's argument names.
  const copilotAdd = run({ tool_name: 'Edit', tool_input: { path: listPath, old_str: 'demo-x1.1.1\n', new_str: 'demo-x1.1.1\ntests/b.test.mjs demo-x1.1.2\n' } })
  check('a Copilot edit that adds a line to the list is allowed', copilotAdd.code === 0, why(copilotAdd))
  const copilotTest = run({ tool_name: 'Edit', tool_input: { path: join(primary, 'tests', 'a.test.mjs'), old_str: 'x', new_str: 'y' } })
  check('a Copilot edit to a listed test is refused', refusedFor(copilotTest, PROTECTED), why(copilotTest))
  const copilotDrop = run({ tool_name: 'Edit', tool_input: { path: listPath, old_str: 'tests/a.test.mjs demo-x1.1.1\n', new_str: '' } })
  check('a Copilot edit that drops a listed line is refused', refusedFor(copilotDrop, DROPS), why(copilotDrop))
  const copilotCreate = run({ tool_name: 'Write', tool_input: { path: listPath, file_text: '# protected tests\n' } })
  check('a Copilot create that drops a listed line is refused', refusedFor(copilotCreate, DROPS), why(copilotCreate))
  const copilotPatch = run({
    tool_name: 'Edit', cwd: primary,
    tool_input: { input: `*** Begin Patch\n*** Update File: ${LIST}\n-tests/a.test.mjs demo-x1.1.1\n*** End Patch\n` },
  })
  check('a Copilot patch named Edit that drops a listed line is refused', refusedFor(copilotPatch, DROPS), why(copilotPatch))
  // VS Code's Local agent: its own tool names and arguments, and no matcher, so reads arrive too.
  const vscodeRead = run({ tool_name: 'read_file', tool_input: { filePath: join(primary, 'tests', 'a.test.mjs'), startLine: 1, endLine: 9 } })
  check('a VS Code read of a listed test is allowed', vscodeRead.code === 0, why(vscodeRead))
  const vscodeTest = run({ tool_name: 'replace_string_in_file', tool_input: { filePath: join(primary, 'tests', 'a.test.mjs'), oldString: 'x', newString: 'y' } })
  check('a VS Code edit to a listed test is refused', refusedFor(vscodeTest, PROTECTED), why(vscodeTest))
  const vscodeDrop = run({ tool_name: 'replace_string_in_file', tool_input: { filePath: listPath, oldString: 'tests/a.test.mjs demo-x1.1.1\n', newString: '' } })
  check('a VS Code edit that drops a listed line is refused', refusedFor(vscodeDrop, DROPS), why(vscodeDrop))
  const multi = (...replacements) => run({ tool_name: 'multi_replace_string_in_file', tool_input: { explanation: 'several', replacements } })
  const otherFile = { filePath: join(primary, 'src', 'x.mjs'), oldString: 'tests/a.test.mjs demo-x1.1.1\n', newString: '' }
  const multiAdd = multi(otherFile, { filePath: listPath, oldString: 'demo-x1.1.1\n', newString: 'demo-x1.1.1\ntests/b.test.mjs demo-x1.1.2\n' })
  check("a VS Code edit to several files applies only the list's replacements to the list", multiAdd.code === 0, why(multiAdd))
  const multiTest = multi(otherFile, { filePath: join(primary, 'tests', 'a.test.mjs'), oldString: 'x', newString: 'y' })
  check('a VS Code edit to several files that touches a listed test is refused', refusedFor(multiTest, PROTECTED), why(multiTest))
  const vscodePatch = run({
    tool_name: 'apply_patch', cwd: primary,
    tool_input: { input: `*** Begin Patch\n*** Update File: ${listPath}\n-tests/a.test.mjs demo-x1.1.1\n*** End Patch\n`, explanation: 'patch' },
  })
  check('a VS Code patch that drops a listed line is refused', refusedFor(vscodePatch, DROPS), why(vscodePatch))

  console.log('guard-delivery: Gate 2 on an agent branch')
  const wt = join(primary, '.claude', 'worktrees', 'story')
  git(primary, 'worktree', 'add', '-q', '-b', 'agent/demo-x1.1.1-build', wt, 'HEAD')
  const feature = { id: 'demo-x1.1', issue_type: 'feature', spec_id: 'docs/specs/demo-x1.1.md', dependency_type: 'parent-child' }
  const story = [{ id: 'demo-x1.1.1', issue_type: 'task', dependencies: [feature] }]
  const code = join(wt, 'src', 'x.mjs')
  const GATE = 'whose spec on origin/main says "Intent confirmed'

  git(primary, 'update-ref', 'refs/remotes/origin/main', intent)
  const early = run(edit(code), { bd: story })
  check('a story writing code before its feature is approved is refused', refusedFor(early, GATE), why(early))
  check(
    'the hook asks bd for every dash-prefix of the worktree name in one call',
    early.bdArgs === 'show --json -- demo demo-x1.1.1 demo-x1.1.1-build',
    JSON.stringify(early.bdArgs),
  )
  const docs = run(edit(join(wt, 'docs', 'specs', 'demo-x1.1.md')), { bd: story })
  check('a path under beforeApprovalPaths stays writable, and bd is not asked', docs.code === 0 && docs.bdArgs === '', why(docs))
  git(primary, 'update-ref', 'refs/remotes/origin/main', approved)
  const late = run(edit(code), { bd: story })
  check('control: once origin/main says Design approved, the story writes code', late.code === 0, why(late))
  git(primary, 'update-ref', 'refs/remotes/origin/main', intent)
  const unspecced = run(edit(code), { bd: [{ ...story[0], dependencies: [{ ...feature, id: 'demo-x1.2' }] }] })
  check('a story whose spec is not on origin/main is refused', refusedFor(unspecced, 'does not exist (docs/specs/demo-x1.2.md)'), why(unspecced))
  const borrowed = run(edit(code), { bd: [{ ...story[0], dependencies: [{ ...feature, spec_id: 'docs/specs/other.md' }] }] })
  check("the tracker's spec_id cannot point a story at another spec", refusedFor(borrowed, GATE), why(borrowed))
  write(join(wt, 'policy', 'delivery.json'), JSON.stringify({ ...POLICY, beforeApprovalPaths: ['src/'] }))
  const widened = run(edit(code), { bd: story })
  check("widening beforeApprovalPaths in the working copy opens nothing", refusedFor(widened, GATE), why(widened))
  git(wt, 'checkout', '-q', '--', 'policy/delivery.json')
  const design = join(primary, '.claude', 'worktrees', 'design')
  git(primary, 'worktree', 'add', '-q', '-b', 'agent/demo-x1.1-design', design, 'HEAD')
  const onFeature = run(edit(join(design, 'src', 'x.mjs')), { bd: [feature] })
  check("a feature's own branch writing code is refused", refusedFor(onFeature, 'carries feature demo-x1.1'), why(onFeature))
  const prefixOnly = run(edit(code), { bd: [{ id: 'demo', issue_type: 'feature' }, ...story] })
  check('the longest id bd finds is the issue', refusedFor(prefixOnly, 'Story demo-x1.1.1'), why(prefixOnly))
  const bug = run(edit(code), { bd: [{ id: 'demo-x1.1.1', issue_type: 'bug', dependencies: [feature] }] })
  check('a defect branch is not gated', bug.code === 0, why(bug))
  // git alone on PATH, so a pass means the hook found no bd rather than no git.
  const gitOnly = join(scratch, 'git-only')
  mkdirSync(gitOnly)
  symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(gitOnly, 'git'))
  const noBd = run(edit(code), { path: gitOnly })
  check('with no bd on PATH the hook fails open', noBd.code === 0, why(noBd))
  const noBdTest = run(edit(join(wt, 'tests', 'a.test.mjs')), { path: gitOnly })
  check('with no bd on PATH a protected test is refused still', refusedFor(noBdTest, PROTECTED), why(noBdTest))
  const bdFails = run(edit(code), { bd: story, status: 1 })
  check('with a bd that errors the hook fails open', bdFails.code === 0, why(bdFails))
  const onMain = run(edit(join(primary, 'src', 'x.mjs')), { bd: story })
  check('off an agent branch bd is not asked', onMain.code === 0 && onMain.bdArgs === '', why(onMain))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-delivery selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-delivery selftest: every case passed')
