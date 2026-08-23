#!/usr/bin/env node
/**
 * One-shot driver for check-closing-keywords-ground-truth.test.sh (#1686):
 * reads a single case from the environment, calls `assess`, and prints the
 * result as JSON.
 *
 * This is a SEPARATE file, not `node -e '...'` importing
 * check-closing-keywords.mjs directly, because that module's own CLI guard
 * is `import.meta.url === file://${process.argv[1]}` — passing the target's
 * own path as an extra CLI arg (needed to build a dynamic `import()`
 * specifier from inside an `-e` string) makes that comparison TRUE by
 * accident, so the module runs its live-fetch CLI branch and exits before
 * the test harness ever calls `assess`. A distinct file sidesteps it: this
 * file's own `import.meta.url` is what CI compares itself against, never
 * check-closing-keywords.mjs's, and the import here is an ordinary static
 * specifier rather than a constructed one.
 */
import { assess } from './check-closing-keywords.mjs'

const body = process.env.PR_BODY ?? ''
const title = process.env.PR_TITLE ?? ''
const commits = process.env.PR_COMMITS ? JSON.parse(process.env.PR_COMMITS) : []
const closingIssuesReferences = process.env.PR_CLOSING_ISSUES
  ? JSON.parse(process.env.PR_CLOSING_ISSUES)
  : []
const changedFiles = (process.env.PR_FILES ?? '').split(' ').filter(Boolean)

const result = assess({ body, title, commits, changedFiles, closingIssuesReferences })
console.log(JSON.stringify(result))
