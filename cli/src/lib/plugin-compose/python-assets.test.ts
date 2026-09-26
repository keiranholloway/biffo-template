import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_PY, CORE_APP_PY, HOST_APP_PY } from './python-assets.js'

describe('embedded python entry points', () => {
  it.each([
    ['core_app.py', CORE_APP_PY],
    ['host_app.py', HOST_APP_PY],
    ['bootstrap.py', BOOTSTRAP_PY],
  ])('%s is valid Python', (_name, source) => {
    const r = spawnSync(
      'python3',
      ['-c', 'import sys; compile(sys.stdin.read(), "asset", "exec")'],
      {
        input: source,
        encoding: 'utf8',
      },
    )
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' })
  })

  it('the IAM shim only sets the authorizer context for a SigV4 Authorization header', () => {
    // Behavioural: exercise the shim class itself (it needs only stdlib + a stub `api.main`).
    const script = `
import asyncio, os, sys, types
os.environ["BIFFO_DEV_IAM_ARN"] = "arn:test"
stub = types.ModuleType("api.main"); stub.app = None
sys.modules["api"] = types.ModuleType("api"); sys.modules["api.main"] = stub
ns = {}
exec(compile(sys.stdin.read(), "core_app", "exec"), ns)
seen = []
async def inner(scope, receive, send): seen.append(scope.get("aws.event"))
shim = ns["LocalIamShim"](inner)
async def go():
    await shim({"type": "http", "headers": [(b"authorization", b"AWS4-HMAC-SHA256 x")]}, None, None)
    await shim({"type": "http", "headers": [(b"authorization", b"Bearer t")]}, None, None)
    await shim({"type": "http", "headers": []}, None, None)
asyncio.run(go())
assert seen[0]["requestContext"]["authorizer"]["iam"]["userArn"] == "arn:test", seen
assert seen[1] is None and seen[2] is None, seen
print("shim-ok")
`
    const r = spawnSync('python3', ['-c', script], { input: CORE_APP_PY, encoding: 'utf8' })
    expect({ out: r.stdout.trim(), err: r.stderr }).toEqual({ out: 'shim-ok', err: '' })
  })
})
