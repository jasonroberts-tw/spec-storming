/**
 * Write native integration files and record their ownership in .harness/integrations.json.
 *
 * Without a complete preflight, selecting another CLI could overwrite local settings or delete
 * edited skills. Only an unchanged owned file, or a file identical to the desired output, is writable.
 *
 *   writeIntegrations({ root, target, integrations, check: false })
 *
 * Needs a writable Target directory. No git, npm, CLI, or network.
 * KIND: integration writer, with a read-only check mode.
 * INVARIANTS: validate all destinations and conflicts before mutation; never follow destination symlinks.
 * RE-ENTRY: unchanged output is not rewritten; check rejects missing, changed, and stale output.
 * STALE WHEN: definitions, adapters, or the selected integrations change.
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { adapters, selectIntegrations } from './adapters.mjs'
import { compare, json } from './formats.mjs'
import { renderIntegrations } from './render.mjs'

const MANIFEST = '.harness/integrations.json'
const digest = (contents) => createHash('sha256').update(contents).digest('hex')

function stat(file) {
  try {
    return lstatSync(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

function outputPath(file) {
  return typeof file === 'string' &&
    Object.values(adapters).some(({ outputPaths }) =>
      outputPaths.some((path) => path.endsWith('/') ? file.startsWith(path) : file === path)) &&
    !file.includes('\\') && !file.includes('\0') &&
    file.split('/').every((part) => part && part !== '.' && part !== '..')
}

function safeDestination(target, file) {
  let current = target
  for (const part of file.split('/')) {
    current = join(current, part)
    if (stat(current)?.isSymbolicLink()) throw new Error('Symlink integration destination: ' + file)
  }
  return current
}

function readManifest(file) {
  if (!stat(file)) return { files: {} }
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (manifest.version !== 1 || !Array.isArray(manifest.integrations) || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Invalid integration ownership manifest')
  }
  selectIntegrations(manifest.integrations)
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!outputPath(path) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error('Invalid owned integration path or digest: ' + path)
    }
  }
  return manifest
}

export function writeIntegrations({ root, target, integrations, check = false }) {
  const rendered = renderIntegrations({ root, integrations })
  const directory = realpathSync(resolve(target))
  if (!stat(directory).isDirectory()) throw new Error('Target is not a directory: ' + target)
  const manifestPath = safeDestination(directory, MANIFEST)
  const previous = readManifest(manifestPath)
  const paths = [...new Set([...rendered.files.keys(), ...Object.keys(previous.files)])].sort(compare)
  const changed = []
  for (const file of paths) {
    if (!outputPath(file)) throw new Error('Invalid integration output path: ' + file)
    const destination = safeDestination(directory, file)
    const existing = stat(destination)
    if (existing && !existing.isFile()) throw new Error('Integration conflict: ' + file + ' is not a file')
    const contents = existing ? readFileSync(destination) : null
    const desired = rendered.files.get(file)
    const same = contents !== null && desired !== undefined && contents.equals(Buffer.from(desired)) &&
      (existing.mode & 0o777) === (rendered.modes.get(file) ?? 0o644)
    if (check) {
      if (!same && (existing || desired !== undefined)) changed.push(file)
    } else if (contents !== null && !same && digest(contents) !== previous.files[file]) {
      throw new Error('Integration conflict: ' + file + ' has local contents; preserve it or move it before rendering')
    }
  }
  const manifest = json({
    version: 1,
    integrations: rendered.integrations,
    files: Object.fromEntries([...rendered.files].map(([file, contents]) => [file, digest(contents)])),
  })
  const manifestSame = stat(manifestPath)?.isFile() && readFileSync(manifestPath, 'utf8') === manifest
  if (check) {
    if (!manifestSame) changed.push(MANIFEST)
    if (changed.length) throw new Error('Integration output differs or is stale: ' + changed.join(', '))
    return rendered
  }
  for (const [file, contents] of rendered.files) {
    const destination = join(directory, file)
    const mode = rendered.modes.get(file) ?? 0o644
    const existing = stat(destination)
    if (existing?.isFile() && readFileSync(destination).equals(Buffer.from(contents)) && (existing.mode & 0o777) === mode) continue
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, contents, { mode })
    chmodSync(destination, mode)
  }
  for (const file of Object.keys(previous.files)) {
    if (rendered.files.has(file) || !stat(join(directory, file))) continue
    unlinkSync(join(directory, file))
    let parent = dirname(join(directory, file))
    while (parent !== directory) {
      try {
        rmdirSync(parent)
      } catch (error) {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
        break
      }
      parent = dirname(parent)
    }
  }
  if (!manifestSame) {
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, manifest)
  }
  return rendered
}
