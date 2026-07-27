/**
 * CI entrypoint for the plugin-collision guard (issue #688): fail when two
 * plugins vendored into one instance claim the same importable name.
 *
 * Scope note: this looks at `services/` in the repo it runs from, which in an
 * instance is where `biffo plugin install` vendors plugins. It is a no-op in a
 * repo with fewer than two plugins — including this template — because a
 * collision needs a second occupant by definition. That is deliberate: the
 * whole defect class was invisible until a second plugin existed, so a guard
 * that only runs where two are installed is the guard running exactly where it
 * can see something.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { findCollisions, formatCollisions } from '../lib/plugin-collision-guard.js'

export async function runPluginCollisionCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const servicesDir = join(root, 'services')

  if (!existsSync(servicesDir)) {
    console.log('✓ plugin collision guard: no services/ directory — nothing to compare')
    return
  }

  const collisions = findCollisions(servicesDir)

  if (collisions.length > 0) {
    console.error('✗ plugin collision guard: two plugins claim the same importable name\n')
    console.error(formatCollisions(collisions))
    console.error(
      '\nThis breaks the plugin that loads *second*, which is usually the one that' +
        '\nwas already working. See biffo-template#688.',
    )
    process.exit(1)
  }

  console.log('✓ plugin collision guard: OK')
}
