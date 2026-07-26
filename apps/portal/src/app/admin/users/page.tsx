'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import {
  type AdminUser,
  type CreateUserRequest,
  type Organization,
  ASSIGNABLE_GROUPS,
  assignGroup,
  createOrganization,
  createUser,
  deleteUser,
  fetchGroups,
  fetchOrganizations,
  fetchUsers,
  reactivateUser,
  removeGroup,
  suspendUser,
} from '@/lib/user-admin-api'

const NEW_ORGANIZATION_VALUE = '__new__'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

function CreateUserForm({
  onCreate,
  assignable,
  organizations,
  onAddOrganization,
}: {
  onCreate: (body: CreateUserRequest) => Promise<void>
  assignable: readonly string[]
  organizations: Organization[]
  onAddOrganization: (name: string) => Promise<Organization>
}) {
  const [email, setEmail] = useState('')
  const [givenName, setGivenName] = useState('')
  const [familyName, setFamilyName] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [newOrgName, setNewOrgName] = useState('')
  const [jobRole, setJobRole] = useState('')
  const [showAddress, setShowAddress] = useState(false)
  const [addressLine1, setAddressLine1] = useState('')
  const [addressLine2, setAddressLine2] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [country, setCountry] = useState('')
  const [groups, setGroups] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  function toggleGroup(group: string) {
    setGroups((current) =>
      current.includes(group) ? current.filter((g) => g !== group) : [...current, group],
    )
  }

  function reset() {
    setEmail('')
    setGivenName('')
    setFamilyName('')
    setPhoneNumber('')
    setOrganizationId('')
    setNewOrgName('')
    setJobRole('')
    setShowAddress(false)
    setAddressLine1('')
    setAddressLine2('')
    setCity('')
    setRegion('')
    setPostalCode('')
    setCountry('')
    setGroups([])
  }

  async function doSubmit() {
    if (email.trim() === '' || givenName.trim() === '' || familyName.trim() === '' || busy) return
    setBusy(true)
    try {
      let resolvedOrgId = organizationId
      if (organizationId === NEW_ORGANIZATION_VALUE) {
        if (newOrgName.trim() === '') {
          setBusy(false)
          return
        }
        resolvedOrgId = (await onAddOrganization(newOrgName.trim())).id
      }
      await onCreate({
        email: email.trim(),
        given_name: givenName.trim(),
        family_name: familyName.trim(),
        phone_number: phoneNumber.trim() || undefined,
        groups,
        organization_id: resolvedOrgId || undefined,
        job_role: jobRole.trim() || undefined,
        address_line1: addressLine1.trim() || undefined,
        address_line2: addressLine2.trim() || undefined,
        city: city.trim() || undefined,
        region: region.trim() || undefined,
        postal_code: postalCode.trim() || undefined,
        country: country.trim() || undefined,
      })
      reset()
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
            className="mt-1 w-56 rounded border px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-gray-600">
          First name
          <input
            type="text"
            required
            value={givenName}
            onChange={(e) => {
              setGivenName(e.target.value)
            }}
            placeholder="Jamie"
            className="mt-1 w-36 rounded border px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-gray-600">
          Last name
          <input
            type="text"
            required
            value={familyName}
            onChange={(e) => {
              setFamilyName(e.target.value)
            }}
            placeholder="Rivera"
            className="mt-1 w-36 rounded border px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-gray-600">
          Phone (optional)
          <input
            type="tel"
            value={phoneNumber}
            onChange={(e) => {
              setPhoneNumber(e.target.value)
            }}
            placeholder="+14155551234"
            className="mt-1 w-40 rounded border px-2 py-1 text-sm"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-600">
          Company (optional)
          <select
            value={organizationId}
            onChange={(e) => {
              setOrganizationId(e.target.value)
            }}
            className="mt-1 w-48 rounded border px-2 py-1 text-sm"
          >
            <option value="">None</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
            <option value={NEW_ORGANIZATION_VALUE}>+ Add new company…</option>
          </select>
        </label>
        {organizationId === NEW_ORGANIZATION_VALUE && (
          <label className="flex flex-col text-xs text-gray-600">
            New company name
            <input
              type="text"
              required
              value={newOrgName}
              onChange={(e) => {
                setNewOrgName(e.target.value)
              }}
              placeholder="Acme Inc."
              className="mt-1 w-48 rounded border px-2 py-1 text-sm"
            />
          </label>
        )}
        <label className="flex flex-col text-xs text-gray-600">
          Job role (optional)
          <input
            type="text"
            value={jobRole}
            onChange={(e) => {
              setJobRole(e.target.value)
            }}
            placeholder="CTO"
            className="mt-1 w-40 rounded border px-2 py-1 text-sm"
          />
        </label>
        <div className="flex flex-col text-xs text-gray-600">
          Initial groups
          <div className="mt-1 flex gap-3">
            {assignable.map((group) => (
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
      </div>

      <details
        className="mt-3"
        open={showAddress}
        onToggle={(e) => {
          setShowAddress(e.currentTarget.open)
        }}
      >
        <summary className="cursor-pointer text-xs font-medium text-gray-600">
          Address (optional)
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs text-gray-600">
            Address line 1
            <input
              type="text"
              value={addressLine1}
              onChange={(e) => {
                setAddressLine1(e.target.value)
              }}
              className="mt-1 w-56 rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs text-gray-600">
            Address line 2
            <input
              type="text"
              value={addressLine2}
              onChange={(e) => {
                setAddressLine2(e.target.value)
              }}
              className="mt-1 w-56 rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs text-gray-600">
            City
            <input
              type="text"
              value={city}
              onChange={(e) => {
                setCity(e.target.value)
              }}
              className="mt-1 w-36 rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs text-gray-600">
            Region / state
            <input
              type="text"
              value={region}
              onChange={(e) => {
                setRegion(e.target.value)
              }}
              className="mt-1 w-36 rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs text-gray-600">
            Postal code
            <input
              type="text"
              value={postalCode}
              onChange={(e) => {
                setPostalCode(e.target.value)
              }}
              className="mt-1 w-28 rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs text-gray-600">
            Country (ISO code)
            <input
              type="text"
              maxLength={2}
              value={country}
              onChange={(e) => {
                setCountry(e.target.value.toUpperCase())
              }}
              placeholder="GB"
              className="mt-1 w-16 rounded border px-2 py-1 text-sm uppercase"
            />
          </label>
        </div>
      </details>

      <div className="mt-3">
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
  assignable,
  disableRemoveGroups = [],
}: {
  user: AdminUser
  onAdd: (group: string) => void
  onRemove: (group: string) => void
  assignable: readonly string[]
  disableRemoveGroups?: readonly string[]
}) {
  const available = assignable.filter((g) => !user.groups.includes(g))
  return (
    <span className="flex flex-wrap items-center gap-1">
      {user.groups.length === 0 && <span className="text-xs text-gray-400">none</span>}
      {user.groups.map((group) => {
        const removeDisabled = disableRemoveGroups.includes(group)
        return (
          <span
            key={group}
            className="flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700"
          >
            {group}
            <button
              type="button"
              aria-label={`Remove ${group} from ${user.email}`}
              disabled={removeDisabled}
              title={removeDisabled ? "You can't remove yourself from this group" : undefined}
              onClick={() => {
                onRemove(group)
              }}
              className="text-gray-400 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-gray-400"
            >
              ×
            </button>
          </span>
        )
      })}
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
  const { getIdToken, session } = useAuth()
  // The signed-in admin's own sub (#630) — used to disable Suspend/Delete and
  // "remove from admin group" on their own row, so self-lockout is caught
  // before the request is even sent, not just enforced server-side.
  const mySub = session?.getIdToken().payload['sub'] as string | undefined
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Live group taxonomy from the API; falls back to the baseline until it loads
  // (or if the endpoint is unavailable) so the picker always renders (issue #148).
  const [assignable, setAssignable] = useState<string[]>([...ASSIGNABLE_GROUPS])
  const [organizations, setOrganizations] = useState<Organization[]>([])

  const client = useMemo(() => createApiClient(getIdToken), [getIdToken])

  useEffect(() => {
    fetchGroups(client)
      .then((result) => {
        if (result.groups.length > 0) setAssignable(result.groups)
      })
      .catch(() => {
        /* keep the fallback groups */
      })
  }, [client])

  const reloadOrganizations = useCallback(async () => {
    try {
      const result = await fetchOrganizations(client)
      setOrganizations(result.organizations)
    } catch {
      /* Company picker just falls back to "None" + add-new */
    }
  }, [client])

  useEffect(() => {
    void reloadOrganizations()
  }, [reloadOrganizations])

  async function addOrganization(name: string): Promise<Organization> {
    const org = await createOrganization(client, name)
    await reloadOrganizations()
    return org
  }

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
        assignable={assignable}
        organizations={organizations}
        onAddOrganization={addOrganization}
        onCreate={(body) => run(() => createUser(client, body))}
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
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Company</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Groups</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((user) => {
                const isSelf = mySub != null && user.sub === mySub
                return (
                  <tr key={user.sub || user.username}>
                    <td className="px-4 py-2 text-gray-800">
                      {[user.given_name, user.family_name].filter(Boolean).join(' ') || (
                        <span className="text-gray-400">—</span>
                      )}
                      {isSelf && <span className="ml-1 text-xs text-gray-400">(you)</span>}
                    </td>
                    <td className="px-4 py-2 text-gray-800">{user.email}</td>
                    <td className="px-4 py-2 text-gray-600">
                      {user.organization_name ?? <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {user.job_role ?? <span className="text-gray-400">—</span>}
                    </td>
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
                        assignable={assignable}
                        disableRemoveGroups={isSelf ? ['admin'] : []}
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
                            disabled={isSelf}
                            title={isSelf ? "You can't suspend your own account" : undefined}
                            onClick={() => {
                              void run(() => suspendUser(client, user.username))
                            }}
                            className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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
                          disabled={isSelf}
                          title={isSelf ? "You can't delete your own account" : undefined}
                          onClick={() => {
                            void run(() => deleteUser(client, user.username))
                          }}
                          className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
