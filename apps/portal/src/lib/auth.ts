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

export function signIn(username: string, password: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: username, Pool: userPool })
    const authDetails = new AuthenticationDetails({ Username: username, Password: password })

    user.authenticateUser(authDetails, {
      onSuccess: (session) => resolve(session),
      onFailure: (err: Error) => reject(err),
      newPasswordRequired: () => reject(new Error('NEW_PASSWORD_REQUIRED')),
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
