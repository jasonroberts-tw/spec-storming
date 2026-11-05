/** Select adapters and substitute CLI vocabulary; prevents workflows naming unavailable tools.
 * Imported by renderers; run directly with a checkout path to print its active integration.
 * Needs only the selection manifest, when present; no CLI or network.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { claude } from './claude.mjs'
import { codex } from './codex.mjs'
import { copilot } from './copilot.mjs'
import { compare } from './formats.mjs'
import { opencode } from './opencode.mjs'

export const adapters = Object.fromEntries([claude, codex, copilot, opencode].map((adapter) => [adapter.id, adapter]))

export function selectIntegrations(integrations = ['claude']) {
  if (!Array.isArray(integrations) || integrations.length === 0) {
    throw new Error('Choose at least one CLI integration')
  }
  for (const id of integrations) {
    if (typeof id !== 'string') throw new Error('CLI integration names must be strings')
    if (!Object.hasOwn(adapters, id)) throw new Error('Unknown CLI integration: ' + id)
  }
  return [...new Set(integrations)].sort(compare)
}

export function renderCliText(source, id) {
  const adapter = adapters[selectIntegrations([id])[0]]
  return source.replace(/\{\{(CLI_[^{}]+)\}\}/g, (whole, key) => {
    if (!Object.hasOwn(adapter.replacements, key)) throw new Error('Unknown integration placeholder: ' + whole)
    return adapter.replacements[key]
  })
}

export function activeIntegration(root, env = process.env) {
  if (env.HARNESS_CLI) return selectIntegrations([env.HARNESS_CLI])[0]
  let integrations
  try {
    integrations = JSON.parse(readFileSync(join(root, '.harness/integrations.json'), 'utf8')).integrations
    if (!Array.isArray(integrations)) throw new Error('Invalid integration selection manifest')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return selectIntegrations(integrations)[0]
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(activeIntegration(resolve(process.argv[2] ?? '.')))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
