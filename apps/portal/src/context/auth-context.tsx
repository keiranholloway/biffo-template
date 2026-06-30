'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { CognitoUserSession } from 'amazon-cognito-identity-js'
import {
  getCurrentSession,
  signIn as cognitoSignIn,
  signOut as cognitoSignOut,
  type SignInResult,
} from '@/lib/auth'

interface AuthContextValue {
  session: CognitoUserSession | null
  loading: boolean
  login: (username: string, password: string) => Promise<SignInResult>
  logout: () => void
  getIdToken: () => string | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<CognitoUserSession | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void getCurrentSession()
      .then(setSession)
      .finally(() => {
        setLoading(false)
      })
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const result = await cognitoSignIn(username, password)
    if (result.kind === 'success') setSession(result.session)
    return result
  }, [])

  const logout = useCallback(() => {
    cognitoSignOut()
    setSession(null)
  }, [])

  const getIdToken = useCallback(() => session?.getIdToken().getJwtToken() ?? null, [session])

  return (
    <AuthContext.Provider value={{ session, loading, login, logout, getIdToken }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === null) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
