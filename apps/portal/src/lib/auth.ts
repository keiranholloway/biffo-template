import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
  type ICognitoUserPoolData,
} from 'amazon-cognito-identity-js'

const poolData: ICognitoUserPoolData = {
  UserPoolId: process.env['NEXT_PUBLIC_COGNITO_USER_POOL_ID'] ?? '',
  ClientId: process.env['NEXT_PUBLIC_COGNITO_CLIENT_ID'] ?? '',
}

export const userPool = new CognitoUserPool(poolData)

export type SignInResult =
  | { kind: 'success'; session: CognitoUserSession }
  | { kind: 'new_password_required'; user: CognitoUser; userAttributes: Record<string, string> }

export function signIn(username: string, password: string): Promise<SignInResult> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: userPool })
    const authDetails = new AuthenticationDetails({ Username: username, Password: password })

    user.authenticateUser(authDetails, {
      onSuccess: (session) => {
        resolve({ kind: 'success', session })
      },
      onFailure: reject,
      newPasswordRequired: (userAttributes: Record<string, string>) => {
        // Cognito includes read-only attributes that must not be sent back
        const { email_verified, email, ...writableAttributes } = userAttributes
        void email_verified
        void email
        resolve({ kind: 'new_password_required', user, userAttributes: writableAttributes })
      },
    })
  })
}

export function completeNewPassword(
  user: CognitoUser,
  newPassword: string,
  userAttributes: Record<string, string>,
): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, userAttributes, {
      onSuccess: resolve,
      onFailure: reject,
    })
  })
}

export function signOut(): void {
  const user = userPool.getCurrentUser()
  user?.signOut()
}

export function getCurrentSession(): Promise<CognitoUserSession | null> {
  return new Promise((resolve) => {
    const user = userPool.getCurrentUser()
    if (!user) {
      resolve(null)
      return
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err ?? !session?.isValid()) {
        resolve(null)
      } else {
        resolve(session)
      }
    })
  })
}
