/**
 * Staged paths a merge brought in from the other side, for the core-ownership
 * guard's `--staged` mode (tabsii-platform#1648).
 *
 * `git diff --cached` compares the index with HEAD. During a merge that diff
 * holds every file the other parent changed, not just what this commit edits.
 * After a core upgrade lands on `dev`, merging `dev` into a branch therefore
 * stages template-owned files the instance received legitimately, and the guard
 * refused the commit as if the merge author had edited them. That is what
 * stopped the fleet's rebaser on tabsii-platform#1648 (2026-10-10), after
 * core-staleness PRs #1671 and #1675 had brought `ddl_order.py`,
 * `_skeletons/*\/.python-version` and others onto `dev`.
 *
 * A staged path is this commit's own edit only when it differs from HEAD AND
 * from every merge head. A path whose staged content (or absence) matches some
 * merge head came in with the merge. A resolution that matches neither parent
 * is a real edit and stays refused.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execa } from './exec.js'

/** The commits being merged, from MERGE_HEAD (one per line; several for an octopus). Empty when no merge is in progress. */
export async function readMergeHeads(root: string): Promise<string[]> {
  const res = await execa('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], {
    cwd: root,
    reject: false,
  })
  if (res.exitCode !== 0) return []
  const rel = String(res.stdout).trim()
  if (!rel) return []
  const file = isAbsolute(rel) ? rel : join(root, rel)
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{7,64}$/.test(l))
  } catch {
    return []
  }
}

/**
 * The subset of `stagedPaths` whose staged state matches at least one merge head,
 * i.e. paths the merge brought in. Fails closed: if any git call fails, that head
 * contributes nothing, so its paths keep counting as edits.
 */
export async function pathsFromMergeHeads(
  root: string,
  stagedPaths: string[],
  heads: string[],
): Promise<Set<string>> {
  const merged = new Set<string>()
  if (heads.length === 0 || stagedPaths.length === 0) return merged
  for (const head of heads) {
    const res = await execa('git', ['diff', '--cached', '--name-only', '--no-renames', head], {
      cwd: root,
      reject: false,
    })
    if (res.exitCode !== 0) continue
    const differs = new Set(
      String(res.stdout)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
    for (const path of stagedPaths) if (!differs.has(path)) merged.add(path)
  }
  return merged
}
