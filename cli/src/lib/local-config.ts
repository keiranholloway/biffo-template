/**
 * Recognising the template's unresolved `biffo.config.json`.
 *
 * The Biffo template ships a `biffo.config.json` whose values are literal
 * `{{PLACEHOLDER}}` tokens, and GitHub template generation copies it verbatim
 * into every scaffolded repo. It is a template artifact, not a configuration:
 * the instance's real, resolved config is written to
 * `~/.biffo/projects/<name>.json` by `biffo init`, and is deliberately never
 * committed (it carries the AWS account id and admin email, both of which the
 * template's own `.gitleaks.toml` forbids in the tree).
 *
 * `biffo init` deletes the placeholder file from repos it scaffolds (issue
 * #269), but repos scaffolded before that fix still carry it — and for them
 * `deploy`/`data-apply` would hard-fail on schema validation and explicitly
 * refuse to fall back to the saved project that holds the right answer. So the
 * commands also detect the file for what it is and fall through, rather than
 * treating an obviously-unsubstituted template as a broken user config.
 *
 * This is narrow on purpose. A config with *some* placeholders left is a
 * genuinely broken config and must still fail loudly; only a file whose
 * required identity fields are *all* still placeholders is treated as absent.
 */

const PLACEHOLDER = /^\{\{[A-Z0-9_]+\}\}$/

function isPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER.test(value)
}

/**
 * True when `raw` is the template's unsubstituted `biffo.config.json` — i.e.
 * every one of the identity fields `biffo init` resolves is still a
 * `{{PLACEHOLDER}}` token. A partially-filled config returns false and is left
 * to fail validation normally.
 */
export function isTemplatePlaceholderConfig(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const config = raw as Record<string, Record<string, unknown>>
  const identityValues = [
    config['project']?.['name'],
    (config['source_control']?.['config'] as Record<string, unknown> | undefined)?.['org'],
    (config['source_control']?.['config'] as Record<string, unknown> | undefined)?.['repo'],
    (config['cloud']?.['config'] as Record<string, unknown> | undefined)?.['account_id'],
    config['admin']?.['email'],
  ]
  return identityValues.length > 0 && identityValues.every(isPlaceholder)
}
