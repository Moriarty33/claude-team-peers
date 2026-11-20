import type { TokenCredential } from '@azure/identity'
import { HANDLE_RE } from './protocol.ts'

export type SignedInUser = { principalName?: string; objectId?: string }

const ARM_SCOPE = 'https://management.azure.com/.default'

/** Turns a sign-in name into a handle: alice.smith@example.com -> alice-smith. */
export function handleFromPrincipal(principal: string): string | undefined {
  let name = principal.trim().toLowerCase()
  const guestMarker = name.indexOf('#ext#')
  if (guestMarker >= 0) {
    // Guest UPNs look like alice_example.com#EXT#@tenant.onmicrosoft.com.
    name = name.slice(0, guestMarker)
    const domainSeparator = name.lastIndexOf('_')
    if (domainSeparator > 0) name = name.slice(0, domainSeparator)
  } else if (name.includes('#')) {
    name = name.slice(name.lastIndexOf('#') + 1)
  }
  const local = name.split('@')[0] ?? ''
  const handle = local
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return HANDLE_RE.test(handle) ? handle : undefined
}

export function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('The Azure access token is not a JWT')
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

export async function signedInUser(credential: TokenCredential): Promise<SignedInUser> {
  const token = await credential.getToken(ARM_SCOPE)
  if (!token) throw new Error('az login returned no token; run az login')
  const claims = decodeClaims(token.token)
  const text = (key: string) => (typeof claims[key] === 'string' ? (claims[key] as string) : undefined)
  return {
    principalName: text('upn') ?? text('unique_name') ?? text('preferred_username') ?? text('email'),
    objectId: text('oid'),
  }
}
