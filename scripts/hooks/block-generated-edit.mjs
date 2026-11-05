/**
 * PreToolUse hook. Refuses a Write, Edit, or Codex patch aimed at a GENERATED file: one whose own header carries a
 * generator's "do not edit by hand" banner.
 *
 * THE DEFECT THIS PREVENTS, which happened: hand-correcting generated output. A brief that tells the
 * reader to fix what an emitter got wrong invites the fix to land in the file that is wrong. That edit
 * survives until the next run of the emitter, which silently reverts it -- or until the gate that
 * diffs the two, which turns it into a build failure with no memory of what the edit was for.
 *
 * The checkout is placed by the edited file's own path (`editedCheckout`), never by the payload's
 * `cwd`, so an edit in a linked worktree is judged as one in the primary checkout is.
 *
 * Exit 2 is the documented way for a PreToolUse hook to block; stderr becomes the reason shown to the
 * agent. The reason is not "don't do that" -- it sends the change to the generator the banner names,
 * so the next move is a fix at the source rather than a guess.
 *
 * Deliberately NOT blocked: the emitters themselves, under `tools/`, which is where fixes go.
 *
 *   node scripts/hooks/block-generated-edit.mjs < payload.json
 *
 * Needs `git`, which places the path: four calls inside a checkout and two outside any, each with no
 * `GIT_*` variable, since an inherited `GIT_DIR` would make git place the path in its own directory.
 * With no git on PATH, every path is judged against this hook's own checkout.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  bannerCheckApplies,
  editTargets,
  editedCheckout,
  hasGeneratedBanner,
  header,
  readHookInput,
} from './_shared.mjs'

const input = await readHookInput()
if (input === null) process.exit(0)

for (const { filePath, text } of editTargets(input)) {
  const target = editedCheckout(filePath)
  if (target === null) continue
  const { root, rel } = target

  // A file whose own header says a generator wrote it.
  //
  // WHICH TEXT IS THE EVIDENCE matters. For a file that already exists, its own header on disk is the
  // authority -- checking the INCOMING text instead blocks any edit that merely quotes a banner, which
  // is a real thing to want to write in a repository whose gates are about build products. For a path
  // that does not exist yet, the incoming text is the only evidence there is, and an agent writing a
  // new file that CLAIMS to be generated is making the same mistake from the other direction.
  const abs = resolve(root, rel)
  const banner =
    bannerCheckApplies(rel) &&
    (existsSync(abs) ? hasGeneratedBanner(header(abs)) : hasGeneratedBanner(text))
  if (banner) {
    process.stderr.write(
      [
        `${rel} carries a generator's "do not edit by hand" banner in its header.`,
        '',
        'Find the tool named in that banner and change it there, then re-run it. If this file is in',
        'fact hand-written and the banner is wrong, remove the banner in the same change -- a file that',
        'lies about its own provenance is worse than either state.',
      ].join('\n'),
    )
    process.exit(2)
  }
}

process.exit(0)
