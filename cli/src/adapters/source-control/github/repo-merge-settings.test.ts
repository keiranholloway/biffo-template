import { describe, expect, it } from 'vitest'
import { REPO_MERGE_SETTINGS } from './index.js'

describe('REPO_MERGE_SETTINGS', () => {
  /**
   * The trap this closes. `gh pr merge --squash --auto` against a repo with
   * auto-merge disabled does not queue — it merges immediately if the PR is
   * mergeable at that instant. On an unprotected branch that means merging with
   * checks still running, which is exactly how biffo-plugin-ideation#54 landed.
   *
   * Every Biffo repo had this false until it was set by hand (#714).
   */
  it('enables auto-merge, so --auto queues instead of merging now', () => {
    expect(REPO_MERGE_SETTINGS.allow_auto_merge).toBe(true)
  })

  it('deletes merged branches, so live branches stay distinguishable', () => {
    expect(REPO_MERGE_SETTINGS.delete_branch_on_merge).toBe(true)
  })
})
