import { describe, expect, it } from 'vitest'

import { pruneForeignCognitoCredentials } from './cognito-hygiene'

/** A minimal Storage over a plain object — enough for Object.keys + removeItem. */
function fakeStorage(entries: Record<string, string>): Storage {
  const map = { ...entries }
  return {
    get length() {
      return Object.keys(map).length
    },
    clear: () => {
      for (const k of Object.keys(map)) delete map[k]
    },
    getItem: (k: string) => map[k] ?? null,
    key: (i: number) => Object.keys(map)[i] ?? null,
    removeItem: (k: string) => {
      delete map[k]
    },
    setItem: (k: string, v: string) => {
      map[k] = v
    },
  } as unknown as Storage
}

const LIVE = '1ccelkl84t2o4euir3op3nco5j'

describe('pruneForeignCognitoCredentials', () => {
  it('removes credentials belonging to other client ids', () => {
    const storage = fakeStorage({
      [`CognitoIdentityServiceProvider.${LIVE}.someone.idToken`]: 'keep',
      [`CognitoIdentityServiceProvider.${LIVE}.LastAuthUser`]: 'keep',
      'CognitoIdentityServiceProvider.5vjn6648jtcsguaodtn786lsi6.someone.idToken': 'dead',
      'CognitoIdentityServiceProvider.5vjn6648jtcsguaodtn786lsi6.LastAuthUser': 'dead',
      'CognitoIdentityServiceProvider.2tvepqhn2j4aje4uqvu9fiu1ge.someone.accessToken': 'dead',
    })

    const removed = pruneForeignCognitoCredentials(LIVE, storage)

    expect(removed).toHaveLength(3)
    expect(storage.length).toBe(2)
    expect(storage.getItem(`CognitoIdentityServiceProvider.${LIVE}.someone.idToken`)).toBe('keep')
    expect(storage.getItem(`CognitoIdentityServiceProvider.${LIVE}.LastAuthUser`)).toBe('keep')
    expect(
      storage.getItem('CognitoIdentityServiceProvider.5vjn6648jtcsguaodtn786lsi6.LastAuthUser'),
    ).toBeNull()
  })

  it('leaves unrelated keys alone', () => {
    const storage = fakeStorage({
      theme: 'dark',
      'amplify-signin-with-hostedUI': 'false',
      [`CognitoIdentityServiceProvider.${LIVE}.LastAuthUser`]: 'keep',
      'CognitoIdentityServiceProvider.dead.LastAuthUser': 'dead',
    })

    pruneForeignCognitoCredentials(LIVE, storage)

    expect(storage.getItem('theme')).toBe('dark')
    expect(storage.getItem('amplify-signin-with-hostedUI')).toBe('false')
  })

  it('does nothing when the client id is unresolved', () => {
    // The dangerous case: treating "no identity" as "nothing matches" would
    // delete the live session along with the residue.
    const storage = fakeStorage({
      [`CognitoIdentityServiceProvider.${LIVE}.LastAuthUser`]: 'keep',
      'CognitoIdentityServiceProvider.dead.LastAuthUser': 'dead',
    })

    expect(pruneForeignCognitoCredentials(null, storage)).toEqual([])
    expect(pruneForeignCognitoCredentials('', storage)).toEqual([])
    expect(storage.getItem(`CognitoIdentityServiceProvider.${LIVE}.LastAuthUser`)).toBe('keep')
    expect(storage.getItem('CognitoIdentityServiceProvider.dead.LastAuthUser')).toBe('dead')
  })

  it('is a no-op without storage, so a Node prerender cannot crash on it', () => {
    expect(pruneForeignCognitoCredentials(LIVE, undefined)).toEqual([])
  })

  it('removes every key of a stale client, not just the first', () => {
    // removeItem() mutates the live key set; index-based iteration would skip
    // entries as it shrinks and leave half the residue behind.
    const entries: Record<string, string> = {
      [`CognitoIdentityServiceProvider.${LIVE}.LastAuthUser`]: 'keep',
    }
    for (let i = 0; i < 12; i++) entries[`CognitoIdentityServiceProvider.dead.k${i}`] = 'x'
    const storage = fakeStorage(entries)

    expect(pruneForeignCognitoCredentials(LIVE, storage)).toHaveLength(12)
    expect(storage.getItem('CognitoIdentityServiceProvider.dead.k11')).toBeNull()
  })
})
