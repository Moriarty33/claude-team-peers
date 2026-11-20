import type { ChatMessage } from './protocol.ts'
import type { ChannelPrefs } from './store.ts'

export type Delivery = 'push' | 'store' | 'ignore'

const BROADCAST_MENTIONS = ['all', 'here', 'channel']

export function mentions(text: string, handle: string): boolean {
  const names = [handle, ...BROADCAST_MENTIONS].join('|')
  return new RegExp(`(^|[^a-z0-9-])@(${names})(?![a-z0-9-])`, 'i').test(text)
}

export function route(message: ChatMessage, me: string, prefs: ChannelPrefs): Delivery {
  if (message.from === me) return 'ignore'
  if (message.to) return message.to === me ? 'push' : 'ignore'
  if (!message.channel) return 'ignore'
  const mode = prefs[message.channel]
  if (!mode) return 'ignore'
  if (mode === 'all') return 'push'
  return mentions(message.text, me) ? 'push' : 'store'
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(limit = 8, windowMs = 60_000, now: () => number = Date.now) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
  }

  allow(key: string): boolean {
    const now = this.now()
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    const allowed = recent.length < this.limit
    if (allowed) recent.push(now)
    this.hits.set(key, recent)
    return allowed
  }
}
