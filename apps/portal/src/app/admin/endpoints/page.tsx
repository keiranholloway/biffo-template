'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { EndpointDetail } from '@/components/EndpointDetail'
import { useAuth } from '@/context/auth-context'
import { ApiError, createApiClient } from '@/lib/api-client'
import {
  changeEndpointPermission,
  type Endpoint,
  type EndpointDetail as Detail,
  type EndpointPermissionResult,
  fetchEndpointDetail,
  fetchEndpoints,
} from '@/lib/endpoint-api'

const METHOD_COLOR: Record<string, string> = {
  GET: 'bg-sky-100 text-sky-700',
  POST: 'bg-emerald-100 text-emerald-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-amber-100 text-amber-700',
  DELETE: 'bg-rose-100 text-rose-700',
}

// The baseline Cognito groups Terraform seeds (modules/cloud/aws/auth). Offered
// as checkboxes; an empty selection means "any authenticated caller".
const KNOWN_ROLES = ['admin', 'editor', 'viewer']

// Unique per mounted route — used as the React key and the expand/edit handle.
function endpointKey(e: Endpoint): string {
  return `${e.method} ${e.path}`
}

interface DetailState {
  loading: boolean
  error: string | null
  detail: Detail | null
}

function permissionErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409)
      return 'That permission is already set this way — there is nothing to change.'
    if (err.status === 501)
      return "The endpoint control plane isn't configured on this deployment. See the setup guide."
    if (err.status === 403) return 'You need administrator access to change endpoint permissions.'
    if (err.status === 502)
      return 'The PR-signer could not complete the request. Please try again shortly.'
    return err.message || `Request failed (${String(err.status)}).`
  }
  return err instanceof Error ? err.message : 'Unknown error'
}

function RoleCell({ roles }: { roles: string[] | null }) {
  if (roles == null) {
    return <span className="text-xs text-gray-400">—</span>
  }
  if (roles.length === 0) {
    return <span className="text-xs text-gray-400">any authenticated</span>
  }
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <span key={r} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700">
          {r}
        </span>
      ))}
    </span>
  )
}

export default function EndpointsPage() {
  const { getIdToken } = useAuth()
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Expandable schema-detail state (one open at a time; results cached by key).
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, DetailState>>({})

  // Inline permission editor state.
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [formAllowed, setFormAllowed] = useState(true)
  const [formRoles, setFormRoles] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [result, setResult] = useState<EndpointPermissionResult | null>(null)

  useEffect(() => {
    const client = createApiClient(getIdToken)
    fetchEndpoints(client)
      .then(setEndpoints)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unknown error')
      })
  }, [getIdToken])

  const toggleExpand = useCallback(
    (e: Endpoint) => {
      const key = endpointKey(e)
      if (expandedKey === key) {
        setExpandedKey(null)
        return
      }
      setExpandedKey(key)
      // Fetch once, then serve from cache on re-expand.
      if (details[key] == null) {
        setDetails((prev) => ({ ...prev, [key]: { loading: true, error: null, detail: null } }))
        fetchEndpointDetail(createApiClient(getIdToken), e.method, e.path)
          .then((detail) => {
            setDetails((prev) => ({ ...prev, [key]: { loading: false, error: null, detail } }))
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'Failed to load details.'
            setDetails((prev) => ({
              ...prev,
              [key]: { loading: false, error: message, detail: null },
            }))
          })
      }
    },
    [expandedKey, details, getIdToken],
  )

  function startEdit(e: Endpoint) {
    setResult(null)
    setFormError(null)
    setEditingKey(endpointKey(e))
    setFormAllowed(true) // listed endpoints are live; the edit can disable or retune roles
    setFormRoles(e.required_role ?? [])
  }

  function toggleRole(role: string) {
    setFormRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]))
  }

  async function submit(e: Endpoint) {
    if (e.plugin == null || e.table == null || e.operation == null) return
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await changeEndpointPermission(createApiClient(getIdToken), {
        plugin: e.plugin,
        table: e.table,
        operation: e.operation,
        allowed: formAllowed,
        required_role: formRoles,
      })
      setResult(res)
      setEditingKey(null)
    } catch (err) {
      setFormError(permissionErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Endpoints</h1>
      <p className="mt-1 text-sm text-gray-600">
        Every live API route on this deployment. Expand a row to see its request and response
        formats. For <strong>plugin</strong> endpoints you can change the required role or disable
        one — this opens a pull request; the change goes live only when it&apos;s merged. Core and
        bespoke endpoints change in code.
      </p>

      {result != null && (
        <div className="mt-6 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          A pull request was opened to apply this change. It goes live when merged.{' '}
          <a
            href={result.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline"
          >
            Review pull request
          </a>
        </div>
      )}

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {endpoints == null && error == null && (
        <div className="mt-6 space-y-2" aria-label="Loading endpoints">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      )}

      {endpoints != null && endpoints.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No endpoints exposed yet</p>
        </div>
      )}

      {endpoints != null && endpoints.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="px-4 py-2">Method</th>
                <th className="px-4 py-2">Path</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2 text-right">Permission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {endpoints.map((e) => {
                const key = endpointKey(e)
                const editing = editingKey === key
                const expanded = expandedKey === key
                const detailState = details[key]
                return (
                  <Fragment key={key}>
                    <tr className={expanded ? 'bg-gray-50' : undefined}>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          onClick={() => {
                            toggleExpand(e)
                          }}
                          aria-expanded={expanded}
                          aria-label={`${expanded ? 'Hide' : 'Show'} details for ${e.method} ${e.path}`}
                          className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100"
                        >
                          <span
                            className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}
                          >
                            ▸
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${
                            METHOD_COLOR[e.method] ?? 'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {e.method}
                        </span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-800">
                        <button
                          type="button"
                          onClick={() => {
                            toggleExpand(e)
                          }}
                          className="text-left hover:underline"
                        >
                          {e.path}
                        </button>
                        {e.summary != null && e.summary !== '' && (
                          <span className="ml-2 font-sans text-gray-400">{e.summary}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-600">
                        {e.source === 'plugin' ? (
                          <>
                            plugin <span className="font-medium text-gray-800">{e.plugin}</span>
                          </>
                        ) : (
                          e.source
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <RoleCell roles={e.required_role} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        {e.permission_editable ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (editing) {
                                setEditingKey(null)
                              } else {
                                startEdit(e)
                              }
                            }}
                            className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          >
                            {editing ? 'Cancel' : 'Change'}
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">in code</span>
                        )}
                      </td>
                    </tr>

                    {expanded && (
                      <tr className="bg-gray-50">
                        <td />
                        <td colSpan={5} className="px-4 py-4">
                          <EndpointDetail
                            detail={detailState?.detail ?? null}
                            loading={detailState?.loading ?? true}
                            error={detailState?.error ?? null}
                          />
                        </td>
                      </tr>
                    )}

                    {editing && (
                      <tr className="bg-gray-50">
                        <td />
                        <td colSpan={5} className="px-4 py-4">
                          <div
                            className="flex flex-col gap-3"
                            aria-label={`Change permission for ${e.method} ${e.path}`}
                          >
                            <label className="flex items-center gap-2 text-sm text-gray-700">
                              <input
                                type="checkbox"
                                checked={formAllowed}
                                onChange={(ev) => {
                                  setFormAllowed(ev.target.checked)
                                }}
                              />
                              Endpoint enabled
                            </label>

                            <fieldset className="flex flex-wrap items-center gap-3">
                              <legend className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                                Required role (any of; none = any authenticated)
                              </legend>
                              {KNOWN_ROLES.map((role) => (
                                <label
                                  key={role}
                                  className="flex items-center gap-1.5 text-sm text-gray-700"
                                >
                                  <input
                                    type="checkbox"
                                    checked={formRoles.includes(role)}
                                    disabled={!formAllowed}
                                    onChange={() => {
                                      toggleRole(role)
                                    }}
                                  />
                                  {role}
                                </label>
                              ))}
                            </fieldset>

                            {formError != null && (
                              <p className="text-sm text-red-700">{formError}</p>
                            )}

                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void submit(e)}
                                disabled={submitting}
                                className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                              >
                                {submitting ? 'Opening pull request…' : 'Open pull request'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingKey(null)
                                }}
                                disabled={submitting}
                                className="rounded px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                              >
                                Cancel
                              </button>
                            </div>
                            <p className="text-xs text-gray-400">
                              This does not change anything live — it opens a pull request you
                              review and merge.
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
