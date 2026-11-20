import { randomUUID } from 'node:crypto'

export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,31}$/
export const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
export const MAX_TEXT = 4000
export const MAX_SUMMARY = 200
export const PRESENCE_TTL_MS = 90_000

export type PeerStatus = {
  repo?: string
  branch?: string
  summary?: string
  startedAt: number
}

export type ChatMessage = {
  v: 1
  kind: 'chat'
  id: string
  from: string
  ts: number
  text: string
  to?: string
  channel?: string
  replyTo?: string
}

export type PresenceMessage = {
  v: 1
  kind: 'presence'
  id: string
  from: string
  ts: number
  status: PeerStatus
}
export type ByeMessage = { v: 1; kind: 'bye'; id: string; from: string; ts: number }
export type Envelope = ChatMessage | PresenceMessage | ByeMessage

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control and bidi characters is the point
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g

export function sanitizeText(text: string, max = MAX_TEXT): string {
  return text.replace(UNSAFE_CHARS, '').slice(0, max)
}

export function normalizeHandle(raw: string): string {
  const handle = raw.trim().replace(/^@/, '').toLowerCase()
  if (!HANDLE_RE.test(handle))
    throw new Error(`Invalid handle "${raw}": use 2-32 lowercase letters, digits or dashes`)
  return handle
}

export function normalizeChannel(raw: string): string {
  const channel = raw.trim().replace(/^#/, '').toLowerCase()
  if (!CHANNEL_RE.test(channel)) {
    throw new Error(`Invalid channel "${raw}": use up to 48 lowercase letters, digits or dashes`)
  }
  return channel
}

type ChatInput = { text: string; to?: string; channel?: string; replyTo?: string }

export function newChat(from: string, input: ChatInput): ChatMessage {
  if (Boolean(input.to) === Boolean(input.channel)) throw new Error('Pass exactly one of "to" or "channel"')
  const text = sanitizeText(input.text).trim()
  if (!text) throw new Error('Message text is empty')
  return {
    v: 1,
    kind: 'chat',
    id: randomUUID(),
    from,
    ts: Date.now(),
    text,
    ...(input.to ? { to: normalizeHandle(input.to) } : {}),
    ...(input.channel ? { channel: normalizeChannel(input.channel) } : {}),
    ...(input.replyTo ? { replyTo: sanitizeText(input.replyTo, 64) } : {}),
  }
}

export function newPresence(from: string, status: PeerStatus): PresenceMessage {
  return { v: 1, kind: 'presence', id: randomUUID(), from, ts: Date.now(), status }
}

export function newBye(from: string): ByeMessage {
  return { v: 1, kind: 'bye', id: randomUUID(), from, ts: Date.now() }
}

const isString = (value: unknown): value is string => typeof value === 'string'
const optionalString = (value: unknown, max: number): string | undefined =>
  isString(value) && value ? sanitizeText(value, max) : undefined

function parseStatus(raw: unknown): PeerStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const status = raw as Record<string, unknown>
  if (typeof status.startedAt !== 'number') return null
  return {
    startedAt: status.startedAt,
    repo: optionalString(status.repo, 100),
    branch: optionalString(status.branch, 200),
    summary: optionalString(status.summary, MAX_SUMMARY),
  }
}

export function parseEnvelope(body: unknown): Envelope | null {
  if (!body || typeof body !== 'object') return null
  const raw = body as Record<string, unknown>
  if (raw.v !== 1 || !isString(raw.id) || !isString(raw.from) || typeof raw.ts !== 'number') return null
  if (!HANDLE_RE.test(raw.from)) return null
  const base = { v: 1 as const, id: sanitizeText(raw.id, 64), from: raw.from, ts: raw.ts }

  if (raw.kind === 'bye') return { ...base, kind: 'bye' }
  if (raw.kind === 'presence') {
    const status = parseStatus(raw.status)
    return status ? { ...base, kind: 'presence', status } : null
  }
  if (raw.kind !== 'chat' || !isString(raw.text)) return null
  const to = isString(raw.to) && HANDLE_RE.test(raw.to) ? raw.to : undefined
  const channel = isString(raw.channel) && CHANNEL_RE.test(raw.channel) ? raw.channel : undefined
  if (Boolean(to) === Boolean(channel)) return null
  const text = sanitizeText(raw.text).trim()
  if (!text) return null
  return { ...base, kind: 'chat', text, to, channel, replyTo: optionalString(raw.replyTo, 64) }
}
