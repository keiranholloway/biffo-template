// Canonical status wording for Biffo admin surfaces (#2495).
//
// One wording, one casing: Title case. The same state was previously written
// "ACTIVE", "Active" and "enabled" on three surfaces. Pair with the
// `.biffo-badge` classes in kit.css.

/** Stored value (any casing) -> canonical label. */
export const STATUS_LABELS = Object.freeze({
  active: 'Active',
  inactive: 'Inactive',
  enabled: 'Enabled',
  disabled: 'Disabled',
  pending: 'Pending',
  draft: 'Draft',
  archived: 'Archived',
  failed: 'Failed',
  error: 'Error',
})

/** Stored value (any casing) -> kit.css badge modifier. */
export const STATUS_TONES = Object.freeze({
  active: 'positive',
  enabled: 'positive',
  pending: 'caution',
  draft: 'caution',
  failed: 'negative',
  error: 'negative',
})

function key(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

/** Canonical label; unknown values are Title-cased rather than passed through. */
export function statusLabel(value) {
  const k = key(value)
  if (k in STATUS_LABELS) return STATUS_LABELS[k]
  return k.charAt(0).toUpperCase() + k.slice(1)
}

/** Badge class string, e.g. "biffo-badge biffo-badge--positive". */
export function statusBadgeClass(value) {
  const tone = STATUS_TONES[key(value)]
  return tone ? `biffo-badge biffo-badge--${tone}` : 'biffo-badge'
}
