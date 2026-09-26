import { describe, expect, it } from 'vitest'
import { isolatedBaseEnv } from './aws-isolation.js'

describe('isolatedBaseEnv (fail closed off real AWS)', () => {
  const ambient = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    AWS_PROFILE: 'operator-role',
    AWS_SESSION_TOKEN: 'real-session',
    AWS_ACCESS_KEY_ID: 'AKIAREALKEY',
    AWS_ENDPOINT_URL_EVENTS: 'https://events.real.example',
    AWS_SHARED_CREDENTIALS_FILE: '/home/dev/.aws/credentials',
    BIFFO_DATABASE_URL: 'postgresql://prod',
    BIFFO_CORE_API_URL: 'https://real.example',
    PYTHONPATH: '/somewhere',
    VIRTUAL_ENV: '/some/venv',
  }
  const env = isolatedBaseEnv(ambient, 'http://127.0.0.1:9')

  it('drops every ambient AWS_*/BIFFO_*/python-path variable, including per-service overrides', () => {
    for (const k of [
      'AWS_PROFILE',
      'AWS_SESSION_TOKEN',
      'AWS_ENDPOINT_URL_EVENTS',
      'AWS_SHARED_CREDENTIALS_FILE',
      'BIFFO_DATABASE_URL',
      'BIFFO_CORE_API_URL',
      'PYTHONPATH',
      'VIRTUAL_ENV',
    ]) {
      expect(env[k]).toBeUndefined()
    }
  })

  it('replaces the real credentials with dummies and points EVERY boto3 client at the sink', () => {
    expect(env.AWS_ACCESS_KEY_ID).toBe('biffodevaccesskey')
    expect(env.AWS_ENDPOINT_URL).toBe('http://127.0.0.1:9')
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('true')
    expect(JSON.stringify(env)).not.toContain('AKIAREALKEY')
  })

  it('keeps what uv and the shell need', () => {
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/dev')
  })
})
