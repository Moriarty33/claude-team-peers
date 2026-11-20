import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export type WrappedKey = { kid: string; wrappedKey: string }

export type KeyWrapper = {
  wrap(dataKey: Buffer): Promise<WrappedKey>
  unwrap(kid: string, wrappedKey: string): Promise<Buffer>
}

export type Sealed = { alg: 'A256GCM'; kid: string; wk: string; iv: string; ct: string; tag: string }

const DATA_KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const CACHE_LIMIT = 256

const b64 = (bytes: Buffer) => bytes.toString('base64')
const fromB64 = (text: string) => Buffer.from(text, 'base64')

function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv, ct, tag: cipher.getAuthTag() }
}

function aesGcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: string): Buffer {
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

export function isSealed(value: unknown): value is Sealed {
  if (!value || typeof value !== 'object') return false
  const sealed = value as Record<string, unknown>
  return (
    sealed.alg === 'A256GCM' &&
    ['kid', 'wk', 'iv', 'ct', 'tag'].every((field) => typeof sealed[field] === 'string')
  )
}

/** Envelope encryption: one random AES-256 data key per session window, wrapped by the key wrapper. */
export class Sealer {
  private readonly wrapper: KeyWrapper
  private readonly sessionTtlMs: number
  private readonly now: () => number
  private readonly dataKeys = new Map<string, Buffer>()
  private session?: { dataKey: Buffer; kid: string; wk: string; createdAt: number }

  constructor(wrapper: KeyWrapper, sessionTtlMs = 3_600_000, now: () => number = Date.now) {
    this.wrapper = wrapper
    this.sessionTtlMs = sessionTtlMs
    this.now = now
  }

  async seal(payload: unknown, aad: string): Promise<Sealed> {
    const session = await this.currentSession()
    const { iv, ct, tag } = aesGcmEncrypt(session.dataKey, Buffer.from(JSON.stringify(payload), 'utf8'), aad)
    return { alg: 'A256GCM', kid: session.kid, wk: session.wk, iv: b64(iv), ct: b64(ct), tag: b64(tag) }
  }

  async open(sealed: Sealed, aad: string): Promise<unknown> {
    const dataKey = await this.dataKeyFor(sealed.kid, sealed.wk)
    const plaintext = aesGcmDecrypt(dataKey, fromB64(sealed.iv), fromB64(sealed.ct), fromB64(sealed.tag), aad)
    return JSON.parse(plaintext.toString('utf8'))
  }

  private async currentSession() {
    if (this.session && this.now() - this.session.createdAt < this.sessionTtlMs) return this.session
    const dataKey = randomBytes(DATA_KEY_BYTES)
    const { kid, wrappedKey } = await this.wrapper.wrap(dataKey)
    this.remember(kid, wrappedKey, dataKey)
    this.session = { dataKey, kid, wk: wrappedKey, createdAt: this.now() }
    return this.session
  }

  private async dataKeyFor(kid: string, wrappedKey: string): Promise<Buffer> {
    const cached = this.dataKeys.get(cacheKey(kid, wrappedKey))
    if (cached) return cached
    const dataKey = await this.wrapper.unwrap(kid, wrappedKey)
    if (dataKey.length !== DATA_KEY_BYTES) throw new Error('Unwrapped data key has the wrong length')
    this.remember(kid, wrappedKey, dataKey)
    return dataKey
  }

  private remember(kid: string, wrappedKey: string, dataKey: Buffer): void {
    if (this.dataKeys.size >= CACHE_LIMIT) {
      const oldest = this.dataKeys.keys().next().value
      if (oldest) this.dataKeys.delete(oldest)
    }
    this.dataKeys.set(cacheKey(kid, wrappedKey), dataKey)
  }
}

function cacheKey(kid: string, wrappedKey: string): string {
  return createHash('sha256').update(kid).update('\n').update(wrappedKey).digest('hex')
}

/** Wraps data keys with a static local key. For the emulator and tests only. */
export class LocalKeyWrapper implements KeyWrapper {
  private readonly key: Buffer
  private readonly kid: string

  constructor(base64Key: string) {
    this.key = fromB64(base64Key)
    if (this.key.length !== DATA_KEY_BYTES) throw new Error('The local key must be 32 bytes, base64 encoded')
    this.kid = `local:${createHash('sha256').update(this.key).digest('hex').slice(0, 16)}`
  }

  async wrap(dataKey: Buffer): Promise<WrappedKey> {
    const { iv, ct, tag } = aesGcmEncrypt(this.key, dataKey, this.kid)
    return { kid: this.kid, wrappedKey: b64(Buffer.concat([iv, tag, ct])) }
  }

  async unwrap(kid: string, wrappedKey: string): Promise<Buffer> {
    if (kid !== this.kid) throw new Error('Message was encrypted with a different local key')
    const raw = fromB64(wrappedKey)
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    return aesGcmDecrypt(this.key, iv, raw.subarray(IV_BYTES + TAG_BYTES), tag, this.kid)
  }
}
