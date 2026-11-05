/**
 * Secrets gate. It runs Betterleaks over commits, with its own rules and any `.betterleaks.toml`
 * and `.betterleaksignore` at the root (or their gitleaks names, which it also reads), and refuses
 * every secret it finds:
 *
 *   - in CI and by hand, every commit reachable from HEAD;
 *   - at pre-push (`--unpushed`), the commits on HEAD that no remote-tracking branch holds.
 *
 * It reads commits, not the tree, because a secret deleted in a later commit is still in the history
 * a push publishes. Pre-push reads only what the push adds, which stays small however long the
 * history grows. CI reads the whole of HEAD's history because a slower tier never trusts a faster
 * one: a push made with `--no-verify`, or a commit from before this gate, is found there. CI reads
 * HEAD and not every branch, so a secret on one branch fails that branch's pull request and no other.
 * The hook runner hands a job no standard input, so the pre-push job cannot read Git's push lines
 * and reads HEAD; a push of another ref is read by CI alone. Every finding prints redacted, because
 * a secret in a CI log is a second leak, with the fingerprint that `.betterleaksignore` takes when the
 * finding is not a secret.
 *
 * THE FAILURE IT EXISTS TO PREVENT. No incident yet: the gate came with the scanner. A credential
 * that reaches origin is readable by everyone who can clone the repository, and stays in every clone
 * after a rewrite, so it has to be revoked. Were this gate wrong, it would let through a token committed and deleted in the
 * next commit, if it read the tree; and every push, if it read a Betterleaks failure, such as a
 * `.betterleaks.toml` it cannot load, as no finding.
 *
 * INVOCATION.
 *
 *   mise run secrets:check                            every commit reachable from HEAD: the CI step
 *   mise run secrets:check --unpushed                 HEAD's commits no remote-tracking branch holds: the pre-push job
 *   mise run secrets:selftest                         (--selftest) each refusal and scope, in scratch repositories
 *   SECRETS_CHECK_ROOT=<dir> mise run secrets:check   the same gate over a doctored copy
 *
 * NEEDS Betterleaks, which `mise.toml` pins and `mise run` puts on the PATH, and Git. No network,
 * because the gate leaves Betterleaks' `--validation` off, and that flag sends a finding to its provider.
 * 0.56 s wall for the gate over 45 commits (1.08 s on the first of four runs) and 4.6 s for its
 * selftest (one run) through `mise run`, by `/usr/bin/time -p` on a macOS laptop with Betterleaks
 * 1.9.0, 2026-10-17. The gate's
 * time grows with the history in CI, and with the unpushed commits at pre-push.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitEnv, gitIn, SCRATCH_GIT_ENV } from '../tools/lib/git-env.ts'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SELF), '..')
const ROOT = process.env.SECRETS_CHECK_ROOT ? resolve(process.env.SECRETS_CHECK_ROOT) : REPO_ROOT
const tail = (text) => (text ?? '').trim().split('\n').slice(-5).join(' | ')

/** What Betterleaks finds in the commits under `root`: `pass`, `skip` or `fail`, with the lines that say why. */
export function runCheck(root, { unpushed = false } = {}) {
  const range = unpushed ? ['HEAD', '--not', '--remotes'] : ['HEAD']
  const scope = unpushed ? 'commit(s) on HEAD that no remote-tracking branch holds' : 'commit(s) reachable from HEAD'
  // No GIT_* key, so a hook's GIT_DIR cannot point git, or the git Betterleaks runs, away from `root`.
  const options = { cwd: root, env: gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  const count = spawnSync('git', ['rev-list', '--count', ...range], options)
  if (count.status !== 0) return { status: 'fail', lines: [`git rev-list failed in ${root}, so the commits to read are unknown: ${tail(count.stderr || count.error?.message)}`] }
  const commits = Number(count.stdout.trim())
  if (commits === 0) return { status: 'skip', lines: [`no ${scope}, so nothing to read`] }

  const run = spawnSync('betterleaks', ['git', '--no-banner', '--redact', `--log-opts=${range.join(' ')}`, '--report-format=json', '--report-path=-', '.'], options)
  if (run.error) return { status: 'fail', lines: [`betterleaks could not start (${run.error.message}); run the gate through \`mise run\`, which puts the pinned Betterleaks on the PATH`] }
  let findings = null
  try {
    findings = JSON.parse(run.stdout)
  } catch {}
  if (!Array.isArray(findings)) return { status: 'fail', lines: [`betterleaks exited ${run.status} without a report of findings, so the commits were not read: ${tail(run.stderr)}`] }
  if (findings.length === 0 && run.status === 0) return { status: 'pass', lines: [`no secret in ${commits} ${scope}`] }
  if (findings.length === 0) return { status: 'fail', lines: [`betterleaks exited ${run.status} with no finding, so its result is unknown: ${tail(run.stderr)}`] }
  return {
    status: 'fail',
    lines: findings.map((f) => `${f.RuleID} in ${f.File}:${f.StartLine} at ${String(f.Commit).slice(0, 7)} (fingerprint ${f.Fingerprint})`),
  }
}

function main() {
  const { status, lines } = runCheck(ROOT, { unpushed: process.argv.includes('--unpushed') })
  if (status === 'fail') {
    console.error(`secrets: refused, ${lines.length} problem(s).\n`)
    for (const line of lines) console.error(`  - ${line}`)
    console.error('\nRevoke a real secret first: it is in the commit, and rewriting the branch does not unpublish what was pushed.')
    process.exit(1)
  }
  console.log(`secrets: ${status === 'skip' ? 'skipped, ' : ''}${lines[0]}.`)
}

/* --------------------------------------------------------------------------------- selftest ----- */

// A GitHub token Betterleaks' `github-pat` rule matches, built here so that no line of this file is one.
const TOKEN = ['ghp', createHash('sha256').update('secrets selftest').digest('hex').slice(0, 36)].join('_')

/**
 * Each case starts from a scratch repository with a bare remote: one commit pushed, one clean commit
 * on top that is not. The doctor breaks one thing; `unpushed` picks the scope it is read with.
 */
function cases() {
  const commitToken = (git, dir) => {
    writeFileSync(join(dir, 'token.txt'), `token = ${TOKEN}\n`)
    git(['add', 'token.txt'])
    git(['commit', '-q', '-m', 'add a token'])
  }
  return [
    { name: 'control: every commit reachable from HEAD, clean', expect: /^no secret in 2 commit\(s\) reachable from HEAD$/ },
    { name: 'control: the unpushed commit, clean', unpushed: true, expect: /^no secret in 1 commit\(s\) on HEAD that no remote-tracking branch holds$/ },
    {
      name: 'a token committed and deleted in the next commit',
      doctor: (git, dir) => {
        commitToken(git, dir)
        git(['rm', '-q', 'token.txt'])
        git(['commit', '-q', '-m', 'delete the token'])
      },
      refuse: /^github-pat in token\.txt:1 at [0-9a-f]{7} \(fingerprint [0-9a-f]{40}:token\.txt:github-pat:1\)$/,
    },
    { name: 'a token in an unpushed commit', unpushed: true, doctor: commitToken, refuse: /^github-pat in token\.txt:1 at [0-9a-f]{7}/ },
    {
      name: 'pre-push leaves a pushed commit to CI',
      unpushed: true,
      doctor: (git, dir) => {
        commitToken(git, dir)
        git(['push', '-q', 'origin', 'main'])
        git(['commit', '-q', '--allow-empty', '-m', 'after the push'])
      },
      expect: /^no secret in 1 commit\(s\) on HEAD that no remote-tracking branch holds$/,
    },
    {
      name: 'nothing unpushed skips clean, and says so',
      unpushed: true,
      doctor: (git) => git(['push', '-q', 'origin', 'main']),
      skip: /^no commit\(s\) on HEAD that no remote-tracking branch holds, so nothing to read$/,
    },
    {
      name: 'a .betterleaks.toml Betterleaks cannot load fails, and is no pass',
      doctor: (git, dir) => writeFileSync(join(dir, '.betterleaks.toml'), '[[rules]\n'),
      refuse: /^betterleaks exited \d+ without a report of findings/,
    },
  ]
}

function fixture(base, name) {
  const dir = join(base, name.replace(/[^a-z0-9]+/gi, '-'))
  const remote = `${dir}.git`
  mkdirSync(dir, { recursive: true })
  gitIn(base, SCRATCH_GIT_ENV)(['init', '-q', '--bare', remote])
  const git = gitIn(dir, SCRATCH_GIT_ENV)
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'selftest'])
  git(['config', 'user.email', 'selftest@example.invalid'])
  git(['remote', 'add', 'origin', remote])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', 'README.md'])
  git(['commit', '-q', '-m', 'first'])
  git(['push', '-q', 'origin', 'main'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n\nA second line.\n')
  git(['commit', '-q', '-am', 'second'])
  return { dir, git }
}

function selftest() {
  const base = mkdtempSync(join(tmpdir(), 'check-secrets-'))
  const results = []
  try {
    for (const { name, unpushed, doctor, expect, refuse, skip } of cases()) {
      const { dir, git } = fixture(base, name)
      doctor?.(git, dir)
      // The gate end to end, as a by-hand run points it at a copy: its exit, and the line that says why.
      const run = spawnSync(process.execPath, [SELF, ...(unpushed ? ['--unpushed'] : [])], {
        env: { ...process.env, SECRETS_CHECK_ROOT: dir },
        encoding: 'utf8',
      })
      const said = `${run.stdout}${run.stderr}`.trim()
      const lines = said.split('\n').map((line) => line.replace(/^\s*- |^secrets: (skipped, )?|\.$/g, ''))
      const [status, reason] = refuse ? [1, refuse] : [0, skip ?? expect]
      let problem = null
      if (run.status !== status) problem = `exited ${run.status}, not ${status}: ${said}`
      else if (!lines.some((line) => reason.test(line))) problem = `exited ${status}, but not for that reason: ${said}`
      else if (skip && !said.startsWith('secrets: skipped, ')) problem = `did not say it skipped: ${said}`
      else if (said.includes(TOKEN)) problem = 'printed the token unredacted'
      results.push({ name, ok: problem === null, detail: problem ?? `exits ${status} for that reason` })
      if (name.startsWith('control') && problem) {
        console.error(`selftest: an undoctored fixture does not pass, so no case can be trusted: ${problem}`)
        process.exit(1)
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  const failed = results.filter((result) => !result.ok)
  for (const { name, ok, detail } of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} -- ${detail}`)
  console.log(`secrets selftest: ${results.length - failed.length}/${results.length} cases hold.`)
  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv.includes('--selftest')) selftest()
else main()
