'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import {
  type AdminUser,
  ASSIGNABLE_GROUPS,
  assignGroup,
  createUser,
  deleteUser,
  fetchUsers,
  reactivateUser,
  removeGroup,
  suspendUser,
} from '@/lib/user-admin-api'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

function CreateUserForm({
  onCreate,
}: {
  onCreate: (email: string, groups: string[]) => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [groups, setGroups] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  function toggleGroup(group: string) {
    setGroups((current) =>
      current.includes(group) ? current.filter((g) => g !== group) : [...current, group],
    )
  }

  async function doSubmit() {
    if (email.trim() === '' || busy) return
    setBusy(true)
    try {
      await onCreate(email.trim(), groups)
      setEmail('')
      setGroups([])
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void doSubmit()
      }}
      className="mt-6 rounded-xl border bg-white p-4 shadow-sm"
    >
      <h2 className="text-sm font-semibold text-gray-900">Add a user</h2>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-600">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
            }}
            placeholder="person@example.com"
            className="mt-1 w-64 rounded border px-2 py-1 text-sm"
          />
        </label>
        <div className="flex flex-col text-xs text-gray-600">
          Initial groups
          <div className="mt-1 flex gap-3">
            {ASSIGNABLE_GROUPS.map((group) => (
              <label key={group} className="flex items-center gap-1 text-sm text-gray-800">
                <input
                  type="checkbox"
                  checked={groups.includes(group)}
                  onChange={() => {
                    toggleGroup(group)
                  }}
                />
                {group}
              </label>
            ))}
          </div>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add user'}
        </button>
      </div>
    </form>
  )
}

function GroupChips({
  user,
  onAdd,
  onRemove,
}: {
  user: AdminUser
  onAdd: (group: string) => void
  onRemove: (group: string) => void
}) {
  const available = ASSIGNABLE_GROUPS.filter((g) => !user.groups.includes(g))
  return (
    <span className="flex flex-wrap items-center gap-1">
      {user.groups.length === 0 && <span className="text-xs text-gray-400">none</span>}
      {user.groups.map((group) => (
        <span
          key={group}
          className="flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700"
        >
          {group}
          <button
            type="button"
            aria-label={`Remove ${group} from ${user.email}`}
            onClick={() => {
              onRemove(group)
            }}
            className="text-gray-400 hover:text-gray-700"
          >
            ×
          </button>
        </span>
      ))}
      {available.length > 0 && (
        <select
          aria-label={`Add group to ${user.email}`}
          value=""
          onChange={(e) => {
            if (e.target.value !== '') onAdd(e.target.value)
          }}
          className="rounded border border-dashed px-1 py-0.5 text-xs text-gray-500"
        >
          <option value="">+ group</option>
          {available.map((group) => (
            <option key={group} value={group}>
              {group}
            </option>
          ))}
        </select>
      )}
    </span>
  )
}

export default function UsersPage() {
  const { getIdToken } = useAuth()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const client = useMemo(() => createApiClient(getIdToken), [getIdToken])

  const reload = useCallback(async () => {
    try {
      const result = await fetchUsers(client)
      setUsers(result.users)
      setError(null)
    } catch (err: unknown) {
      setError(errorMessage(err))
    }
  }, [client])

  useEffect(() => {
    void reload()
  }, [reload])

  // Run a mutation, surface any error, and refresh the list from the server so
  // the UI reflects Cognito's actual state rather than optimistic guesses.
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      await reload()
    } catch (err: unknown) {
      setError(errorMessage(err))
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Users</h1>
      <p className="mt-1 text-sm text-gray-600">
        Add users, assign them to groups, and suspend or remove them. Group membership is the source
        of truth for access (ADR-0004); suspending revokes a user&apos;s sessions.
      </p>

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <CreateUserForm
        onCreate={(email, groups) => run(() => createUser(client, { email, groups }))}
      />

      {users == null && error == null && (
        <div className="mt-6 space-y-2" aria-label="Loading users">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      )}

      {users != null && users.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No users yet</p>
          <p className="mt-1 text-xs text-gray-400">Add one above to get started.</p>
        </div>
      )}

      {users != null && users.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Groups</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((user) => (
                <tr key={user.sub || user.username}>
                  <td className="px-4 py-2 text-gray-800">{user.email}</td>
                  <td className="px-4 py-2">
                    {user.enabled ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">
                        {user.status || 'active'}
                      </span>
                    ) : (
                      <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs text-rose-700">
                        suspended
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <GroupChips
                      user={user}
                      onAdd={(group) => {
                        void run(() => assignGroup(client, user.username, group))
                      }}
                      onRemove={(group) => {
                        void run(() => removeGroup(client, user.username, group))
                      }}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      {user.enabled ? (
                        <button
                          type="button"
                          onClick={() => {
                            void run(() => suspendUser(client, user.username))
                          }}
                          className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        >
                          Suspend
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            void run(() => reactivateUser(client, user.username))
                          }}
                          className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        >
                          Reactivate
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          void run(() => deleteUser(client, user.username))
                        }}
                        className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
