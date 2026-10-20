import { makeTmpDir } from './tmp.js'
import { tmpdir } from 'node:os'

/** Set by `vitest.config.ts` to the TMPDIR as it was BEFORE the per-run
 * override, i.e. a short path. */
export const TSX_TMP_BASE_ENV = 'BIFFO_TSX_TMP_BASE'

/**
 * An environment for a child process that runs `tsx`, with its own short
 * `TMPDIR`.
 *
 * `tsx` binds its IPC pipe at `$TMPDIR/tsx-<uid>/<pid>.pipe`, a unix socket
 * whose path is limited to 107 characters. Under the per-run TMPDIR that path
 * is longer than that in the fleet sandbox, gets truncated, and every pipe
 * then has the same name: concurrent children die with `listen EADDRINUSE`.
 * A fresh directory per spawn, under the short pre-override base, keeps the
 * path short and means no two children share a pipe directory.
 *
 * The directory comes from `makeTmpDir`, so it is swept with the test file's
 * other fixtures. Pass the result as the `env` option of `spawn`/`execFile`.
 */
export function tsxChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = makeTmpDir('tsx', process.env[TSX_TMP_BASE_ENV] ?? tmpdir())
  return { ...process.env, ...extra, TMPDIR: dir, TMP: dir, TEMP: dir }
}
