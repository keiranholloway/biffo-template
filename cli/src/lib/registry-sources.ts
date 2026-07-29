/**
 * Adding a plugin to the registry's `sources.json`, so the store finds it.
 *
 * ## Why a new plugin needs this at all
 *
 * The registry keeps entries current two ways. The **push** path
 * (`publish-registry.yml` in each plugin repo) is immediate but needs a
 * cross-repo token. The **pull** path (`sync-plugins.yml` in the registry) needs
 * no credential — but it only re-derives the plugins listed in `sources.json`.
 *
 * So a brand-new plugin repo is in neither: no token set, and not listed. It
 * would never appear in the store until somebody remembered to add it by hand.
 *
 * That is precisely the failure this whole mechanism exists to prevent.
 * `plugins.json` shipped `"plugins": []` from the day it was created, and the
 * portal read "No plugins available yet" on every instance while real plugins
 * ran in production — because registering one was a manual step nothing
 * performed. Recreating it one level up, for the *sources* list, would be the
 * same bug wearing a different hat.
 *
 * Registering at create time costs no credential: the command already holds the
 * operator's own GitHub auth, because it just used it to create the repo.
 */

export interface RegistrySource {
  name: string
  repo: string
  manifest: string
  tags: string[]
}

export interface SourcesFile {
  note?: string
  sources: RegistrySource[]
}

/** Where a standalone plugin repo's manifest lives, raw, on its integration branch. */
export function manifestUrlFor(repoUrl: string, branch = 'dev'): string {
  const slug = repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  return `https://raw.githubusercontent.com/${slug}/${branch}/biffo.plugin.json`
}

/**
 * Add `source` to `file` unless its name is already listed.
 *
 * Returns null when nothing changed, so the caller can skip an empty commit —
 * re-running `plugin create` against an existing registration is not an error.
 */
export function addSource(file: SourcesFile, source: RegistrySource): SourcesFile | null {
  if (file.sources.some((s) => s.name === source.name)) return null
  return { ...file, sources: [...file.sources, source] }
}

/** Serialise the way the registry's own tooling writes it, so diffs stay minimal. */
export function serialiseSources(file: SourcesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}
