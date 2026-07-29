/**
 * The status-check contexts a GitHub Actions workflow will report (#803).
 *
 * Branch protection has to name required checks *exactly* as they appear on the
 * commit status API, and GitHub derives that string from a job's `name:` — or
 * from the job id when `name:` is absent. Getting it wrong fails quietly in the
 * worst direction: protection is configured, looks configured, and requires a
 * check that will never arrive, so every PR blocks for ever on a green branch.
 *
 * ## Why this parses rather than hardcodes
 *
 * A hardcoded list would be a second source of truth for job names the skeleton
 * already declares, and would drift the moment someone renames a CI job — the
 * exact failure this repo keeps rediscovering (#243, #325, #803) where a
 * maintained thing and its consumer fall out of step with nothing to notice.
 * Reading the workflow the scaffold just wrote keeps one source of truth.
 *
 * ## Why it is not a YAML parser
 *
 * The CLI has no YAML dependency, and adding one to read job names would be a
 * large answer to a small question. This reads the narrow structure GitHub
 * Actions mandates — a top-level `jobs:` mapping, one job per key, an optional
 * `name:` scalar within each — over a file the **template itself owns**. That
 * is a much weaker assumption than parsing arbitrary user YAML, and
 * `workflow-check-contexts.test.ts` pins it against the real skeleton workflow
 * so a reformat that defeats this fails a test rather than mis-configuring a
 * repo.
 *
 * It deliberately does not handle: flow-style mappings (`jobs: {build: ...}`),
 * anchors/aliases, or multi-line scalars for `name:`. None appear in any
 * workflow this repo ships, and a silently wrong answer is worse than an
 * obviously empty one — callers treat an empty result as "could not determine".
 */

/** Strip surrounding quotes from a YAML scalar, if present. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Job check contexts declared by `workflow`, in file order.
 *
 * Returns `[]` when no `jobs:` block is found, which callers must treat as
 * "unknown" rather than "no checks required".
 */
export function workflowCheckContexts(workflow: string): string[] {
  const lines = workflow.split('\n')

  const jobsIndex = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line))
  if (jobsIndex === -1) return []

  const contexts: string[] = []
  let currentJobId: string | null = null
  let currentJobIndent = 0
  let currentName: string | null = null

  const flush = (): void => {
    if (currentJobId !== null) contexts.push(currentName ?? currentJobId)
    currentJobId = null
    currentName = null
  }

  for (const line of lines.slice(jobsIndex + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue

    // A non-indented line ends the jobs block.
    if (!/^\s/.test(line)) break

    const jobMatch = /^(\s+)([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line)
    if (jobMatch?.[1] !== undefined && jobMatch[2] !== undefined) {
      const indent = jobMatch[1].length
      // The first job key establishes the indent every sibling job shares;
      // anything deeper is a key *within* a job (steps, strategy, …).
      if (currentJobId === null || indent === currentJobIndent) {
        flush()
        currentJobId = jobMatch[2]
        currentJobIndent = indent
        continue
      }
    }

    if (currentJobId === null) continue

    const nameMatch = /^(\s+)name:\s*(.+?)\s*$/.exec(line)
    // Only a job's OWN name counts — a `name:` nested deeper belongs to a step.
    if (
      nameMatch?.[1] !== undefined &&
      nameMatch[2] !== undefined &&
      nameMatch[1].length === currentJobIndent + 2 &&
      currentName === null
    ) {
      currentName = unquote(nameMatch[2])
    }
  }

  flush()
  return contexts
}
