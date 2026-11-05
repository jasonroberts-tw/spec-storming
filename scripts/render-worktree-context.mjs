/**
 * Allocate a worktree's pair of ports and render its briefing from the template beside this file.
 *
 * Prints `KEY=value` lines on stdout for the caller to read, and writes two files into the
 * worktree: `.worktree/CONTEXT.md`, the briefing rendered from `.harness/worktree-CONTEXT.md.tmpl`,
 * and `.worktree/ports.env`, the pair. This script is the one reader of `ports.env`: it reads every
 * sibling worktree's copy, so as not to hand out a pair already promised. A server a person starts
 * in the worktree is given `APP_PORT` as its `PORT`.
 *
 * The failures it exists to prevent. It is a separate Node file rather than more shell because of
 * the first three, each a defect the shell version had:
 *
 * 1. `sed "s|{{X}}|<value>|"` treats `&` in the REPLACEMENT as "the whole match" and `\` as an
 *    escape. Verified: a path containing `a&b` rendered as `a{{WORKTREE_PATH}}b`, silently, with a
 *    zero exit code. Substitution here is a replacer FUNCTION, so every value is literal.
 * 2. `date -u -d "+2 hours"` is GNU-only. On a BSD or busybox `date` the shell script aborted
 *    AFTER creating the worktree and branch, leaving both behind.
 * 3. The ports were `hash % 900` with nothing checking them. They are probed here, so the header's
 *    "non-colliding" claim is true rather than a hope.
 * 4. The template is the one beside this file (`ROOT` below has no override), so the copy of this
 *    script that runs decides which template renders. `scripts/new-worktree.sh` ran the primary
 *    checkout's copy, whose working tree can trail the base a worktree is cut from. On 2026-09-23
 *    a worktree cut from `origin/main` opened with the template the checkout had at an older
 *    commit, still carrying a sentence the base had replaced. On 2026-09-25 another, cut while the
 *    checkout stood behind the base, was told to open its pull request with an inline
 *    `gh pr create`, a step the base had replaced with the `open-pr` skill; `AGENTS.md` gives the
 *    briefing precedence, so the stale step won. The caller now runs the new worktree's own copy, so the briefing is the
 *    base's template, whatever state the primary checkout is in.
 *
 *   node <worktree-path>/scripts/render-worktree-context.mjs \
 *     <worktree-path> <branch> <base-sha> <task-ref> [hours]
 *
 * Called by `scripts/new-worktree.sh`, from the new worktree's checkout. Needs `git` on PATH, for
 * the list of sibling worktrees, and binds loopback ports for a moment to probe them.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activeIntegration, renderCliText } from '../tools/integrations/adapters.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = join(ROOT, '.harness', 'worktree-CONTEXT.md.tmpl')

const [worktreePath, branch, baseSha, taskRef, hoursArg] = process.argv.slice(2)
if (!worktreePath || !branch || !baseSha || !taskRef) {
  console.error(
    'usage: render-worktree-context.mjs <worktree-path> <branch> <base-sha> <task-ref> [hours]',
  )
  process.exit(1)
}
const lifetimeHours = Number(hoursArg ?? 2) || 2

/* ============================================================================================= *
 * Ports.
 * ============================================================================================= */

/** Is nothing listening on this port? Probed on the loopback, where a dev server binds. */
function free(port) {
  return new Promise((done) => {
    const s = createServer()
    s.once('error', () => done(false))
    s.once('listening', () => s.close(() => done(true)))
    s.listen(port, '127.0.0.1')
  })
}

/**
 * Ports already promised to a sibling worktree.
 *
 * Probing alone is not enough: a worktree provisioned a minute ago has a port reserved in its
 * `ports.env` but nothing listening on it yet, so two agents would be handed the same pair and the
 * second would fail to bind whenever it happened to start second.
 */
function reservedBySiblings() {
  const taken = new Set()
  let porcelain
  try {
    porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
  } catch {
    return taken
  }
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const file = join(line.slice('worktree '.length).trim(), '.worktree', 'ports.env')
    if (!existsSync(file)) continue
    for (const m of readFileSync(file, 'utf8').matchAll(/^[A-Z_]+=(\d+)$/gm)) {
      taken.add(Number(m[1]))
    }
  }
  return taken
}

/** A stable 32-bit hash of the branch name, so the same branch tends to get the same ports. */
function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Two adjacent free ports, reserved for the worktree. The first, APP_PORT, is the one to pass as
 * `PORT` to a server started there; the second is unused.
 *
 * The hash picks where to start looking; availability decides where it stops. 900 blocks of ten in
 * 20000-28990, walked in order from the hashed start, so a collision costs one step here rather
 * than a server that fails to bind later.
 */
async function allocate(name) {
  const reserved = reservedBySiblings()
  const start = hash(name) % 900
  for (let i = 0; i < 900; i++) {
    const base = 20000 + ((start + i) % 900) * 10
    const pair = [base, base + 1]
    if (pair.some((p) => reserved.has(p))) continue
    const checks = await Promise.all(pair.map(free))
    if (checks.every(Boolean)) return { APP_PORT: pair[0], SB_PORT: pair[1] }
  }
  throw new Error(
    'no free port block in 20000-28999; stop some dev servers or remove stale worktrees',
  )
}

/* ============================================================================================= *
 * Render.
 * ============================================================================================= */

/** `YYYY-MM-DD HH:MMZ`, the format the template's prose is written around. */
function stamp(date) {
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}Z`
}

const ports = await allocate(branch)
const now = new Date()

/**
 * The primary checkout, which `git worktree list` prints first: where `main` is checked out, and
 * where a `via-merge` finish fast-forwards it. Without git, this checkout, which is the primary one
 * whenever the worktree script runs from there.
 */
function primaryCheckout() {
  try {
    const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    return porcelain.match(/^worktree (.+)$/m)?.[1] ?? ROOT
  } catch {
    return ROOT
  }
}

const values = {
  WORKTREE_PATH: worktreePath,
  PRIMARY_CHECKOUT: primaryCheckout(),
  BRANCH: branch,
  BASE_SHA: baseSha,
  TASK_REF: taskRef,
  STARTED_AT: stamp(now),
  DEADLINE: stamp(new Date(now.getTime() + lifetimeHours * 3600_000)),
  APP_PORT: String(ports.APP_PORT),
  SB_PORT: String(ports.SB_PORT),
}

const template = renderCliText(readFileSync(TEMPLATE, 'utf8'), activeIntegration(ROOT))
// A replacer function, so `&`, `$&` and `\` in a value are literal text and not sed/regex syntax.
const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
  Object.hasOwn(values, key) ? values[key] : whole,
)

// A placeholder the template asks for and the script does not supply is a mismatch between two
// files that are edited separately. Fail loudly here rather than shipping `{{DB_NAME}}` to an agent.
const leftover = [...new Set([...rendered.matchAll(/\{\{[A-Z_]+\}\}/g)].map((m) => m[0]))]
if (leftover.length > 0) {
  console.error(`unsubstituted placeholders in the rendered context: ${leftover.join(', ')}`)
  process.exit(1)
}

const outDir = join(worktreePath, '.worktree')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'CONTEXT.md'), rendered, 'utf8')
writeFileSync(
  join(outDir, 'ports.env'),
  `# Written by scripts/render-worktree-context.mjs, the one reader of this file: it reads every\n` +
    `# worktree's copy to keep their pairs apart. No server reads it by itself; pass\n` +
    `# APP_PORT to one as PORT.\n` +
    `APP_PORT=${ports.APP_PORT}\nSB_PORT=${ports.SB_PORT}\n`,
  'utf8',
)

for (const [key, value] of Object.entries({ ...values, CONTEXT: join(outDir, 'CONTEXT.md') })) {
  console.log(`${key}=${value}`)
}
