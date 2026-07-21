'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { CognitoUser } from 'amazon-cognito-identity-js'
import { useAuth } from '@/context/auth-context'
import { completeNewPassword, confirmPasswordReset, requestPasswordReset } from '@/lib/auth'
import { sanitizeReturnTo } from '@/lib/return-to'
import { Button } from '@biffo/ui'

// useSearchParams() requires a Suspense boundary in the App Router (it opts
// the tree below it out of static rendering) — the actual form lives in
// LoginForm so this default export can provide that boundary.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}

// Maps the failure of a password-reset confirmation to a user-friendly message.
// Cognito surfaces these as Error instances whose `name` is the exception code.
function confirmResetErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  switch (name) {
    case 'CodeMismatchException':
      return 'That code is not correct. Check the code from your email and try again.'
    case 'ExpiredCodeException':
      return 'That code has expired. Request a new one and try again.'
    case 'LimitExceededException':
      return 'Too many attempts. Please wait a while before trying again.'
    default:
      return err instanceof Error ? err.message : 'Failed to reset password'
  }
}

// A missing account must look identical to a successful send so the form cannot
// be used to enumerate valid usernames — UserNotFoundException is swallowed and
// still advances to the code-entry step. LimitExceededException is the one
// request-time error worth surfacing, since it is actionable.
const RESET_CODE_SENT_NOTICE =
  'If an account exists for that username, a reset code has been sent to its email.'

function requestResetOutcome(err: unknown): { notice: string; sent: boolean } {
  const name = err instanceof Error ? err.name : ''
  if (name === 'LimitExceededException') {
    return { notice: 'Too many attempts. Please wait a while before trying again.', sent: false }
  }
  return { notice: RESET_CODE_SENT_NOTICE, sent: true }
}

function LoginForm() {
  const { login } = useAuth()
  const router = useRouter()
  // Set by a sibling app (ADR-0007) when it finds no shared session and
  // bounces here — e.g. /login?return_to=/my-sibling/. Sanitised to a
  // same-origin relative path only; see sanitizeReturnTo's own comment for
  // why an absolute URL here would be an open-redirect risk.
  const returnTo = sanitizeReturnTo(useSearchParams().get('return_to'))

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // New-password-required state
  const [pendingUser, setPendingUser] = useState<CognitoUser | null>(null)
  const [pendingAttributes, setPendingAttributes] = useState<Record<string, string>>({})
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Forgot-password state. `resetMode` toggles the whole reset view on; once a
  // code has been requested, `codeSent` advances to the confirmation step.
  const [resetMode, setResetMode] = useState(false)
  const [codeSent, setCodeSent] = useState(false)
  const [resetNotice, setResetNotice] = useState<string | null>(null)
  const [resetCode, setResetCode] = useState('')
  const [resetNewPassword, setResetNewPassword] = useState('')
  const [resetConfirmPassword, setResetConfirmPassword] = useState('')

  const handleSignIn = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const result = await login(username, password)
      if (result.kind === 'success') {
        router.push(returnTo)
      } else {
        setPendingUser(result.user)
        setPendingAttributes(result.userAttributes)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setLoading(false)
    }
  }

  const handleSetPassword = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)
    try {
      if (!pendingUser) return
      await completeNewPassword(pendingUser, newPassword, pendingAttributes)
      router.push(returnTo)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set password')
    } finally {
      setLoading(false)
    }
  }

  const openReset = () => {
    setResetMode(true)
    setCodeSent(false)
    setError(null)
    setResetNotice(null)
    setResetCode('')
    setResetNewPassword('')
    setResetConfirmPassword('')
  }

  const backToSignIn = () => {
    setResetMode(false)
    setError(null)
    setResetNotice(null)
  }

  const handleRequestReset = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setResetNotice(null)
    setLoading(true)

    try {
      await requestPasswordReset(username)
      setCodeSent(true)
      setResetNotice(RESET_CODE_SENT_NOTICE)
    } catch (err) {
      const { notice, sent } = requestResetOutcome(err)
      if (sent) setCodeSent(true)
      setResetNotice(notice)
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmReset = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)

    if (resetNewPassword !== resetConfirmPassword) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)
    try {
      await confirmPasswordReset(username, resetCode, resetNewPassword)
      // Reset succeeded — drop back to the sign-in form so the user can sign in
      // with the new password.
      setResetMode(false)
      setCodeSent(false)
      setResetNotice(null)
      setPassword('')
    } catch (err) {
      setError(confirmResetErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  if (resetMode) {
    return (
      <div className="w-full max-w-sm rounded-xl border bg-white p-8 shadow-sm">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">Reset your password</h1>
        <p className="mb-6 text-sm text-gray-500">
          {codeSent
            ? 'Enter the code from your email along with a new password.'
            : 'Enter your username or email and we will send a reset code to your email.'}
        </p>

        {!codeSent ? (
          <form
            onSubmit={(e) => {
              void handleRequestReset(e)
            }}
            className="flex flex-col gap-4"
          >
            <div>
              <label
                htmlFor="reset-username"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                Username or email
              </label>
              <input
                id="reset-username"
                type="text"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value)
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
                autoComplete="username"
              />
            </div>

            {resetNotice != null && (
              <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">{resetNotice}</p>
            )}

            <Button
              type="submit"
              className="mt-2 w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
            >
              {loading ? 'Sending code…' : 'Send reset code'}
            </Button>

            <button
              type="button"
              onClick={backToSignIn}
              className="text-sm text-blue-600 hover:underline"
            >
              Back to sign in
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              void handleConfirmReset(e)
            }}
            className="flex flex-col gap-4"
          >
            <div>
              <label htmlFor="reset-code" className="mb-1 block text-sm font-medium text-gray-700">
                Reset code
              </label>
              <input
                id="reset-code"
                type="text"
                value={resetCode}
                onChange={(e) => {
                  setResetCode(e.target.value)
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
                autoComplete="one-time-code"
                inputMode="numeric"
              />
            </div>

            <div>
              <label
                htmlFor="reset-new-password"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                New password
              </label>
              <input
                id="reset-new-password"
                type="password"
                value={resetNewPassword}
                onChange={(e) => {
                  setResetNewPassword(e.target.value)
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
                autoComplete="new-password"
              />
            </div>

            <div>
              <label
                htmlFor="reset-confirm-password"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                Confirm password
              </label>
              <input
                id="reset-confirm-password"
                type="password"
                value={resetConfirmPassword}
                onChange={(e) => {
                  setResetConfirmPassword(e.target.value)
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
                autoComplete="new-password"
              />
            </div>

            {resetNotice != null && error == null && (
              <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">{resetNotice}</p>
            )}

            {error != null && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}

            <Button
              type="submit"
              className="mt-2 w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
            >
              {loading ? 'Resetting…' : 'Reset password'}
            </Button>

            <button
              type="button"
              onClick={backToSignIn}
              className="text-sm text-blue-600 hover:underline"
            >
              Back to sign in
            </button>
          </form>
        )}
      </div>
    )
  }

  if (pendingUser !== null) {
    return (
      <div className="w-full max-w-sm rounded-xl border bg-white p-8 shadow-sm">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">Set a new password</h1>
        <p className="mb-6 text-sm text-gray-500">
          Your temporary password has expired. Please choose a permanent password.
        </p>

        <form
          onSubmit={(e) => {
            void handleSetPassword(e)
          }}
          className="flex flex-col gap-4"
        >
          <div>
            <label htmlFor="new-password" className="mb-1 block text-sm font-medium text-gray-700">
              New password
            </label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value)
              }}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
              autoComplete="new-password"
            />
          </div>

          <div>
            <label
              htmlFor="confirm-password"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              Confirm password
            </label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value)
              }}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
              autoComplete="new-password"
            />
          </div>

          {error != null && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          <Button
            type="submit"
            className="mt-2 w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={loading}
          >
            {loading ? 'Setting password…' : 'Set password'}
          </Button>
        </form>
      </div>
    )
  }

  return (
    <div className="w-full max-w-sm rounded-xl border bg-white p-8 shadow-sm">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Sign in</h1>

      <form
        onSubmit={(e) => {
          void handleSignIn(e)
        }}
        className="flex flex-col gap-4"
      >
        <div>
          <label htmlFor="username" className="mb-1 block text-sm font-medium text-gray-700">
            Username or email
          </label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
            }}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
            autoComplete="username"
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium text-gray-700">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
            }}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
            autoComplete="current-password"
          />
        </div>

        {error != null && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <Button
          type="submit"
          className="mt-2 w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={loading}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>

        <button type="button" onClick={openReset} className="text-sm text-blue-600 hover:underline">
          Forgot password?
        </button>
      </form>
    </div>
  )
}
