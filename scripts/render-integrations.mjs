/**
 * Render the CLI integrations selected for a Target project, or compare them without writing.
 *
 * Copying one CLI's files to every Target project made selection impossible and gave shared rules
 * a separate home per CLI. This command renders the neutral definitions using the selected adapters.
 *
 *   node scripts/render-integrations.mjs [--integrations claude,codex] [--source dir] [--check] <target-dir>
 *
 * Needs Node and the shared Template files, but no npm install, CLI, credential, or network.
 * KIND: deterministic integration emitter.
 * INVARIANTS: leaves common Template files alone; refuses local conflicts before any writes.
 * RE-ENTRY: idempotent; --check reports drift and writes nothing.
 * STALE WHEN: .harness source, adapters, or integration selection changes.
 */
import { resolve } from 'node:path'
import { writeIntegrations } from '../tools/integrations/write.mjs'
import { TEMPLATE_ROOT } from '../tools/integrations/render.mjs'

const usage = 'usage: render-integrations.mjs [--integrations claude,codex] [--source dir] [--check] <target-dir>'
const args = process.argv.slice(2)
try {
  let integrations
  let root = TEMPLATE_ROOT
  let check = false
  let target
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      console.log(usage)
      process.exit(0)
    }
    const [flag, inline] = arg.split(/=(.*)/s)
    if (flag === '--integrations' || flag === '--source') {
      if (seen.has(flag)) throw new Error('Repeated argument: ' + flag)
      seen.add(flag)
      const value = inline ?? args[++index]
      if (value === undefined || value.startsWith('--')) throw new Error('Missing value for ' + flag)
      if (flag === '--integrations') integrations = value.split(',').map((id) => id.trim())
      else root = resolve(value)
    } else if (arg === '--check') {
      check = true
    } else if (arg.startsWith('-')) {
      throw new Error('Unknown argument: ' + arg)
    } else if (target !== undefined) {
      throw new Error('Expected one Target directory')
    } else {
      target = resolve(arg)
    }
  }
  if (!target) throw new Error(usage)
  const result = writeIntegrations({ root, target, integrations, check })
  for (const warning of result.warnings) console.error(warning)
  console.log((check ? 'Checked' : 'Rendered') + ' CLI integrations: ' + result.integrations.join(', ') + ' in ' + target)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
