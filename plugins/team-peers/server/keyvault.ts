import type { TokenCredential } from '@azure/identity'
import { CryptographyClient, KeyClient, type KeyVaultKey } from '@azure/keyvault-keys'
import type { KeyWrapper, WrappedKey } from './crypto.ts'

const WRAP_ALGORITHM = 'RSA-OAEP-256'
const LATEST_KEY_TTL_MS = 3_600_000

export function normalizeVaultUrl(raw: string): string {
  const url = new URL(raw.includes('://') ? raw : `https://${raw}.vault.azure.net`)
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.vault.azure.net')) {
    throw new Error(`Key Vault URL must be https://<name>.vault.azure.net, got "${raw}"`)
  }
  return `https://${url.hostname}`
}

// A message carries the key id it was wrapped with; only versions of our own key may be sent to the SDK.
export function isTrustedKid(vaultUrl: string, keyName: string, kid: string): boolean {
  const prefix = `${vaultUrl}/keys/${keyName}/`
  return kid.startsWith(prefix) && /^[0-9a-f]{32}$/.test(kid.slice(prefix.length))
}

export class KeyVaultKeyWrapper implements KeyWrapper {
  private readonly vaultUrl: string
  private readonly keyName: string
  private readonly credential: TokenCredential
  private readonly keys: KeyClient
  private latest?: { key: KeyVaultKey; fetchedAt: number }

  constructor(vaultUrl: string, keyName: string, credential: TokenCredential) {
    this.vaultUrl = normalizeVaultUrl(vaultUrl)
    this.keyName = keyName
    this.credential = credential
    this.keys = new KeyClient(this.vaultUrl, credential)
  }

  async wrap(dataKey: Buffer): Promise<WrappedKey> {
    const key = await this.latestKey()
    const result = await new CryptographyClient(key, this.credential).wrapKey(WRAP_ALGORITHM, dataKey)
    const kid = result.keyID ?? key.id
    if (!kid || !isTrustedKid(this.vaultUrl, this.keyName, kid)) throw new Error(`Unexpected key id ${kid}`)
    return { kid, wrappedKey: Buffer.from(result.result).toString('base64') }
  }

  async unwrap(kid: string, wrappedKey: string): Promise<Buffer> {
    if (!isTrustedKid(this.vaultUrl, this.keyName, kid))
      throw new Error('Message was wrapped with a foreign key')
    const client = new CryptographyClient(kid, this.credential)
    const result = await client.unwrapKey(WRAP_ALGORITHM, Buffer.from(wrappedKey, 'base64'))
    return Buffer.from(result.result)
  }

  private async latestKey(): Promise<KeyVaultKey> {
    if (this.latest && Date.now() - this.latest.fetchedAt < LATEST_KEY_TTL_MS) return this.latest.key
    const key = await this.keys.getKey(this.keyName)
    this.latest = { key, fetchedAt: Date.now() }
    return key
  }
}
