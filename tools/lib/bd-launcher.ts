/**
 * Where `bd`, the issue tracker's CLI, is on THIS machine, and how to start it without a shell.
 *
 * TWO CALLERS spawned `bd` and each used to resolve it on its own: `scripts/check-beads.mjs` with
 * `execFileSync('bd', ...)` and a catch-all that turned every error into "bd is not installed", and
 * the learning loop's filing step, with
 * `spawnSync('bd', args, { shell: process.platform === 'win32' })` and Node's DEP0190 warning on
 * every run. That step is retired with the loop; `check-beads.mjs` is the one caller left.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. On native Windows `bd` is the npm package `@beads/bd`, and what
 * `where bd` finds is `%APPDATA%\npm\bd` -- a `#!/bin/sh` shim, beside `bd.cmd` and `bd.ps1`, all
 * wrapping `node %APPDATA%\npm\node_modules\@beads\bd\bin\bd.js`. Node's `execFile` without a shell
 * hands the name to CreateProcess, which runs neither a shell script nor a `.cmd`, so the spawn threw
 * ENOENT and the catch reported a FOUND `bd` as ABSENT: `beads:check`, the one pre-push gate that
 * reads the tracker, printed "skipped: bd export produced nothing here" and exited 0 while `bd export`
 * from the same shell wrote 107 issues (measured 2026-09-08). A gate that is green without having
 * looked is the mirror of the failure `check-beads.mjs`'s own header argues against, and nothing in
 * the output told the two apart.
 *
 * Since 2026-10-03 every machine takes `bd` from mise, whose shims on Windows are `.exe` files by
 * default, so the first rule below finds `bd.exe`. That has not been run on Windows here. The npm
 * rule stays for a machine set up the old way.
 *
 * WHAT THIS RESOLVES, in PATH order, first hit wins:
 *
 *   win32     `bd.exe` in a PATH directory -> spawn it directly.
 *             `bd` or `bd.cmd` (an npm shim) with `node_modules/@beads/bd/bin/bd.js` beside it ->
 *             spawn `process.execPath` on that `bd.js`; verified 2026-09-08 that
 *             `node <npm prefix>/node_modules/@beads/bd/bin/bd.js --version` prints `bd version 1.2.2`.
 *             A shim with NO package beside it is FOUND BUT NOT RUNNABLE: CreateProcess cannot start
 *             it and this module will not reach for `shell: true` to try.
 *   elsewhere `bd` in a PATH directory -> spawn it directly (the `@beads/bd` install on Linux is a
 *             symlink to `bd.js` with a `#!/usr/bin/env node` line, which the kernel runs itself). A
 *             `bd` that is present but not executable is likewise found-not-runnable.
 *
 * TELLING "NOT INSTALLED" FROM "FAILED TO RUN" IS THE CONTRACT, not a nicety. `found: false` is the
 * only result a caller may skip on -- a fresh clone, CI, a machine with no tracker. Everything else
 * is evidence of a `bd` on this machine, and a caller that then cannot export from it has a failure to
 * report, never a skip. `runBd` therefore never throws: a spawn error (`ENOENT`, `EACCES`) comes back
 * as `error` with `status: null`, so the caller prints it instead of catching it away.
 *
 * NO `shell: true` ANYWHERE. Under `shell: true` Node concatenates the arguments into one command
 * line rather than escaping them (the DEP0190 deprecation), so a path with a space or a title with a
 * quote in it changes meaning. Every spawn here is `command` + `args[]`, and on win32 the command is
 * either a real `.exe` or `process.execPath`, both of which CreateProcess starts.
 *
 * `resolveBd()` takes the platform, the environment and the PATH delimiter as OPTIONS, defaulting to
 * the process's own, so a selftest can walk the win32 branch on a Linux host with a fixture
 * directory in place of `%APPDATA%\npm`. Nothing here reads `../sibling`.
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter as nativeDelimiter, join } from 'node:path'

/** What to spawn, and how it was found. */
export interface BdLauncher {
  /** The executable handed to `spawnSync`: `bd.exe`, the PATH `bd`, or `process.execPath`. */
  command: string
  /** Arguments that go BEFORE the bd arguments -- the `bd.js` path when `command` is node, else empty. */
  prefix: string[]
  /** `exe`: a `bd.exe` on PATH. `npm-package`: node on `@beads/bd`'s `bd.js`. `path`: a POSIX `bd`. */
  via: 'exe' | 'npm-package' | 'path'
  /** The PATH entry that resolved it: the file for `exe` and `path`, the shim for `npm-package`. */
  location: string
}

export type BdResolution =
  | { found: true; runnable: true; launcher: BdLauncher }
  | { found: true; runnable: false; location: string; reason: string }
  | { found: false; reason: string }

export interface ResolveOptions {
  /** Defaults to `process.platform`. */
  platform?: string
  /** Defaults to `process.env`. `PATH` is read case-insensitively (`Path` on Windows). */
  env?: NodeJS.ProcessEnv
  /** Defaults to `node:path`'s delimiter for THIS host, which is why a stubbed platform passes its own. */
  delimiter?: string
  /** Defaults to `process.execPath`; the node that runs `@beads/bd`'s `bd.js`. */
  execPath?: string
}

const PACKAGE_MAIN = ['node_modules', '@beads', 'bd', 'bin', 'bd.js']

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The PATH entries, in order, empties dropped and win32's optional surrounding quotes removed. */
function pathEntries(env: NodeJS.ProcessEnv, delimiter: string): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const raw = key === undefined ? '' : (env[key] ?? '')
  return raw
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0)
}

/**
 * Find `bd` on PATH and decide how to start it. Reads the file system; spawns nothing.
 */
export function resolveBd(options: ResolveOptions = {}): BdResolution {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const delimiter = options.delimiter ?? nativeDelimiter
  const execPath = options.execPath ?? process.execPath
  const entries = pathEntries(env, delimiter)

  if (entries.length === 0) {
    return { found: false, reason: 'PATH is empty or unset, so there is nowhere to look for `bd`' }
  }

  if (platform === 'win32') {
    for (const dir of entries) {
      const exe = join(dir, 'bd.exe')
      if (isFile(exe)) {
        return {
          found: true,
          runnable: true,
          launcher: { command: exe, prefix: [], via: 'exe', location: exe },
        }
      }
      const shim = [join(dir, 'bd.cmd'), join(dir, 'bd')].find(isFile)
      if (shim === undefined) continue
      const main = join(dir, ...PACKAGE_MAIN)
      if (isFile(main)) {
        return {
          found: true,
          runnable: true,
          launcher: { command: execPath, prefix: [main], via: 'npm-package', location: shim },
        }
      }
      return {
        found: true,
        runnable: false,
        location: shim,
        reason:
          `${shim} is a shell or .cmd shim that CreateProcess cannot start, and no @beads/bd package ` +
          `sits beside it (${main} is absent). Install \`bd\` as the npm package @beads/bd or put a ` +
          'bd.exe on PATH.',
      }
    }
    return {
      found: false,
      reason: `no bd.exe, bd.cmd or bd in any of the ${String(entries.length)} PATH entries`,
    }
  }

  for (const dir of entries) {
    const candidate = join(dir, 'bd')
    if (!isFile(candidate)) continue
    if (!isExecutable(candidate)) {
      return {
        found: true,
        runnable: false,
        location: candidate,
        reason: `${candidate} exists but is not executable`,
      }
    }
    return {
      found: true,
      runnable: true,
      launcher: { command: candidate, prefix: [], via: 'path', location: candidate },
    }
  }
  return {
    found: false,
    reason: `no executable \`bd\` in any of the ${String(entries.length)} PATH entries`,
  }
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  maxBuffer?: number
}

export interface BdRun {
  /** The exit code, or `null` when the process could not be started or was killed. */
  status: number | null
  stdout: string
  stderr: string
  /** The spawn error (`ENOENT`, `EACCES`, ...) when `status` is null for that reason; else null. */
  error: Error | null
}

/** One line naming the launcher, for gate output: which `bd` a verdict was read through. */
export function describeLauncher(launcher: BdLauncher): string {
  switch (launcher.via) {
    case 'exe':
      return launcher.command
    case 'npm-package':
      return `${launcher.command} ${launcher.prefix.join(' ')} (the @beads/bd package behind ${launcher.location})`
    case 'path':
      return launcher.command
  }
}

/**
 * Run `bd <args>` through a resolved launcher. Never throws; `NO_COLOR=1` is set because bd 1.2.2
 * probes the terminal with escape sequences otherwise.
 */
export function runBd(launcher: BdLauncher, args: string[], options: RunOptions = {}): BdRun {
  const run = spawnSync(launcher.command, [...launcher.prefix, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    shell: false,
    windowsHide: true,
    env: { ...(options.env ?? process.env), NO_COLOR: '1' },
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  })
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    error: run.error ?? null,
  }
}

/** Where the win32 branch expects `@beads/bd`'s `bd.js` relative to a shim's directory, where a selftest builds its fixture. */
export function packageMainBeside(shimDir: string): string {
  return join(shimDir, ...PACKAGE_MAIN)
}
