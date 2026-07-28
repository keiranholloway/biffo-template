'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@biffo/ui'
import {
  fetchPluginBySlug,
  installCommandFor,
  type RegistryPluginEntry,
} from '@/lib/plugin-registry'

interface PluginDetailProps {
  slug: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'not-found' }
  | { status: 'found'; plugin: RegistryPluginEntry }

export function PluginDetail({ slug }: PluginDetailProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })

    fetchPluginBySlug(slug)
      .then((plugin) => {
        if (cancelled) return
        setState(plugin === null ? { status: 'not-found' } : { status: 'found', plugin })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        })
      })

    return () => {
      cancelled = true
    }
  }, [slug])

  if (state.status === 'loading') {
    return (
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <div className="h-6 w-48 animate-pulse rounded bg-gray-200" />
        <div className="mt-3 h-4 w-full max-w-md animate-pulse rounded bg-gray-200" />
        <div className="mt-2 h-4 w-2/3 max-w-sm animate-pulse rounded bg-gray-200" />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6">
        <h1 className="text-lg font-semibold text-red-800">Could not load plugin registry</h1>
        <p className="mt-1 text-sm text-red-700">{state.message}</p>
      </div>
    )
  }

  if (state.status === 'not-found') {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
        <h1 className="text-lg font-semibold text-gray-900">
          Plugin &ldquo;{slug}&rdquo; not found
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          It isn&apos;t in the plugin registry. It may have been renamed, unpublished, or the
          registry hasn&apos;t published any plugins yet.
        </p>
        <Link
          href="/admin/plugins/"
          className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline"
        >
          Back to marketplace
        </Link>
      </div>
    )
  }

  const { plugin } = state
  const installCommand = installCommandFor(plugin)
  // Built-in plugins ship inside core at services/_plugins/ and are
  // distributed by `biffo core upgrade`. `biffo plugin upgrade` guards on
  // services/<name>/ and would tell you to run `biffo plugin install`, which
  // would then clone the whole template into services/<name>/ — so the
  // install command must not be offered for them at all.
  const isBuiltIn = plugin.tags?.includes('built-in') ?? false

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{plugin.name}</h1>
            <p className="mt-1 text-sm text-gray-500">
              v{plugin.version} &middot; by {plugin.author ?? 'Unknown'}
            </p>
          </div>
          <span
            className={
              plugin.status === 'active'
                ? 'rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800'
                : 'rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600'
            }
          >
            {plugin.status}
          </span>
        </div>

        {plugin.description != null && (
          <p className="mt-4 text-sm text-gray-700">{plugin.description}</p>
        )}

        {plugin.tags != null && plugin.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {plugin.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {plugin.required_core_version != null && (
          <p className="mt-4 text-xs text-gray-400">
            Requires Biffo core version{' '}
            <code className="font-mono text-gray-600">{plugin.required_core_version}</code>
          </p>
        )}

        {plugin.repo !== '' && (
          <p className="mt-4 text-sm">
            <a
              href={plugin.repo}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-blue-600 hover:underline"
            >
              View source on GitHub ↗
            </a>
          </p>
        )}
      </div>

      {isBuiltIn ? (
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900">Already installed</h2>
          <p className="mt-1 text-sm text-gray-600">
            This plugin ships inside Biffo core, so every instance already has it — there is nothing
            to install. Its source lives in the core template under{' '}
            <code className="font-mono text-gray-700">services/_plugins/{plugin.name}/</code>, and
            it is distributed by <code className="font-mono text-gray-700">biffo core upgrade</code>{' '}
            along with the rest of core.
          </p>
          <p className="mt-3 text-xs text-gray-400">
            Do not run <code className="font-mono">biffo plugin install</code> against it — that
            command is for third-party plugins that live in their own repository.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900">Install</h2>
          <p className="mt-1 text-sm text-gray-600">
            Biffo plugins are installed from the command line, not from the portal — the CLI clones
            the plugin&apos;s source into your project&apos;s own repo and commits it, so you can
            review the diff before pushing. Run this from the root of your Biffo project checkout:
          </p>

          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-gray-900 px-4 py-3">
            <code className="overflow-x-auto whitespace-pre font-mono text-sm text-gray-100">
              {installCommand}
            </code>
            <Button
              variant="secondary"
              className="shrink-0 rounded-md bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-600"
              onClick={() => {
                void navigator.clipboard.writeText(installCommand).then(() => {
                  setCopied(true)
                  setTimeout(() => {
                    setCopied(false)
                  }, 2000)
                })
              }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>

          <p className="mt-3 text-xs text-gray-400">
            Add <code className="font-mono">--dry-run</code> to preview the change without modifying
            your repo.
          </p>
        </div>
      )}
    </div>
  )
}
