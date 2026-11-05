/**
 * Paths, in a module with NO side effects.
 *
 * Side-effect free, deliberately. Anything that imports this must be able to ask where the artifacts
 * are without running a build step.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The repository root. Every other path here is relative to this. */
export const ROOT = resolve(HERE, '../..')

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
