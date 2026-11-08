/**
 * The delivery guard on a fan-out lane's branch: `guard-delivery.mjs` run as the harness runs it,
 * over a scratch repository with a stub `bd` that knows one story, beside controls that must pass.
 * It is the protected test that reproduces ss-pq2, so it holds only the lane's cases;
 * `guard-delivery.selftest.mjs` holds the rest of the guard's.
 *
 * THE FAILURE THIS PREVENTS. In the 2026-11-07 sweep, lane C worked ss-pys on the branch
 * `agent/agent-afc52fc1d47d858a5`, the name the Agent tool's worktree isolation gives a lane.
 * `branchIssue` asked `bd` for `agent` and `agent-afc52fc1d47d858a5`, `bd` found neither and exited
 * 1, and the hook allowed the edit. On a lane carrying a story, that lets code be written before the
 * operator approves the feature's design, and nothing says so.
 *
 * The hook judges only files in its own repository, so the hook, `_shared.mjs` and the live
 * `policy/delivery.json` are copied into the scratch repository and run from there: that copy is
 * this selftest's root override. The stub `bd` answers as the real one did when measured on
 * 2026-11-07: the issues it knows as a JSON array with exit 0, and an error with exit 1 when it
 * knows none of the ids asked.
 *
 *   mise run guard-delivery:selftest      (node scripts/hooks/guard-delivery-lane.selftest.mjs)
 *
 * Needs `git` and a POSIX `sh` for the stub. It writes only under the temporary directory.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS = dirname(fileURLToPath(import.meta.url))
const POLICY = JSON.parse(readFileSync(resolve(HOOKS, '..', '..', 'policy', 'delivery.json'), 'utf8'))
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

const LANE = 'agent-afc52fc1d47d858a5'
const STORY = 'demo-x1.1.1'
const scratch = mkdtempSync(join(tmpdir(), 'guard-delivery-lane-'))
const primary = join(scratch, 'primary')
const bin = join(scratch, 'bin')
const bdOut = join(scratch, 'bd-out.json')
const HOOK = join(primary, 'scripts', 'hooks', 'guard-delivery.mjs')

try {
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: GIT_ENV })
  for (const file of ['_shared.mjs', 'guard-delivery.mjs']) {
    mkdirSync(join(primary, 'scripts', 'hooks'), { recursive: true })
    copyFileSync(join(HOOKS, file), join(primary, 'scripts', 'hooks', file))
  }
  write(join(primary, 'policy', 'delivery.json'), JSON.stringify(POLICY, null, 2))
  write(join(primary, POLICY.protectedTestsFile), '# protected tests\n')
  write(join(primary, 'src', 'x.mjs'), 'x\n')
  write(join(primary, POLICY.specDirectory, 'demo-x1.1.md'), '# Feature\n\n**Status:** Intent confirmed 2026-11-07\n')
  const intent = commit(primary, 'init')
  write(join(primary, POLICY.specDirectory, 'demo-x1.1.md'), '# Feature\n\n**Status:** Design approved 2026-11-07\n')
  const approved = commit(primary, 'approve')
  git(primary, 'reset', '-q', '--hard', intent)
  git(primary, 'update-ref', 'refs/remotes/origin/main', intent)

  const feature = { id: 'demo-x1.1', issue_type: 'feature', dependency_type: 'parent-child' }
  write(bdOut, JSON.stringify([{ id: STORY, issue_type: 'task', dependencies: [feature] }]))
  mkdirSync(bin)
  write(
    join(bin, 'bd'),
    '#!/bin/sh\n' +
      'for id in "$@"; do\n' +
      '  if [ "$id" = "$STUB_BD_ID" ]; then cat "$STUB_BD_OUT"; exit 0; fi\n' +
      'done\n' +
      'printf \'%s\\n\' \'{"error": "no issues found matching the provided IDs"}\'\n' +
      'exit 1\n',
  )
  chmodSync(join(bin, 'bd'), 0o755)

  const run = (file) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: 'y' } }),
      cwd: scratch,
      env: { ...GIT_ENV, PATH: `${bin}${delimiter}${process.env.PATH}`, STUB_BD_OUT: bdOut, STUB_BD_ID: STORY },
      encoding: 'utf8',
    })
    return { code: r.status ?? 1, stderr: r.stderr ?? '' }
  }
  const why = (r) => `code=${r.code} ${JSON.stringify(r.stderr.slice(0, 160))}`

  console.log('guard-delivery: Gate 2 on a fan-out lane')
  const wt = join(primary, '.claude', 'worktrees', LANE)
  git(primary, 'worktree', 'add', '-q', '-b', `agent/${LANE}`, wt, 'HEAD')
  const code = join(wt, 'src', 'x.mjs')

  const spec = run(join(wt, POLICY.specDirectory, 'demo-x1.1.md'))
  check("control: a path under beforeApprovalPaths stays writable on the lane's branch", spec.code === 0, why(spec))
  const unnamed = run(code)
  check(
    `code on agent/${LANE}, a branch that names no issue, is refused for naming none`,
    unnamed.code === 2 && unnamed.stderr.includes('names no issue'),
    why(unnamed),
  )
  git(wt, 'branch', '-m', `agent/${STORY}-${LANE}`)
  const renamed = run(code)
  check(
    'once the lane names its story in its branch, the hook finds the story and holds it at Gate 2',
    renamed.code === 2 && renamed.stderr.includes(`Story ${STORY}`),
    why(renamed),
  )
  git(primary, 'update-ref', 'refs/remotes/origin/main', approved)
  const late = run(code)
  check('control: once origin/main says Design approved, the renamed lane writes code', late.code === 0, why(late))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures) {
  console.log(`guard-delivery lane selftest: ${failures} failure(s)`)
  process.exit(1)
}
console.log('guard-delivery lane selftest: every case passed')
