import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { Bus } from './bus.ts'
import type { Config } from './config.ts'
import {
  type ChatMessage,
  type Envelope,
  newBye,
  newPresence,
  type PeerStatus,
  PRESENCE_TTL_MS,
} from './protocol.ts'
import { RateLimiter, route } from './router.ts'
import type { PeerEntry, Store } from './store.ts'

const runFile = promisify(execFile)
const HEARTBEAT_MS = 30_000
const ERROR_NOTICE_INTERVAL_MS = 10 * 60_000

export type Push = (content: string, meta: Record<string, string>) => Promise<void>

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await runFile('git', ['-C', cwd, ...args], { timeout: 2000 })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

async function workspaceStatus(cwd: string): Promise<Pick<PeerStatus, 'repo' | 'branch'>> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) return {}
  return { repo: basename(top), branch: await git(cwd, ['branch', '--show-current']) }
}

function chatMeta(message: ChatMessage): Record<string, string> {
  return {
    kind: 'chat',
    from: message.from,
    message_id: message.id,
    sent_at: new Date(message.ts).toISOString(),
    ...(message.channel ? { channel: message.channel } : { direct: 'true' }),
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
  }
}

export class Listener {
  private readonly config: Config
  private readonly bus: Bus
  private readonly store: Store
  private readonly push: Push
  private readonly roster = new Map<string, PeerEntry>()
  private readonly limiter = new RateLimiter()
  private readonly throttledPeers = new Set<string>()
  private readonly startedAt = Date.now()
  private readonly cwd = process.cwd()
  private heartbeat?: NodeJS.Timeout
  private lastErrorNoticeAt = 0

  constructor(config: Config, bus: Bus, store: Store, push: Push) {
    this.config = config
    this.bus = bus
    this.store = store
    this.push = push
  }

  async start(): Promise<void> {
    this.bus.subscribe(
      (envelope) => this.onEnvelope(envelope),
      (error) => this.onError(error),
    )
    await this.beat()
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS)
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat)
    await this.bus.send(newBye(this.config.handle)).catch(() => undefined)
  }

  peers(): PeerEntry[] {
    this.prune()
    return [...this.roster.values()].sort((a, b) => a.handle.localeCompare(b.handle))
  }

  async beat(): Promise<void> {
    const status: PeerStatus = {
      ...(await workspaceStatus(this.cwd)),
      summary: this.store.summary(),
      startedAt: this.startedAt,
    }
    await this.bus.send(newPresence(this.config.handle, status)).catch((error) => this.onError(error))
    this.persistPeers()
  }

  private async onEnvelope(envelope: Envelope): Promise<void> {
    if (envelope.from === this.config.handle) return
    if (envelope.kind === 'presence') {
      this.roster.set(envelope.from, { handle: envelope.from, status: envelope.status, lastSeen: Date.now() })
      this.persistPeers()
      return
    }
    if (envelope.kind === 'bye') {
      this.roster.delete(envelope.from)
      this.persistPeers()
      return
    }
    await this.onChat(envelope)
  }

  private async onChat(message: ChatMessage): Promise<void> {
    const delivery = route(message, this.config.handle, this.store.channels())
    if (delivery === 'ignore') return
    this.store.appendHistory({ ...message, direction: 'in' })
    if (delivery === 'store') return
    if (!this.limiter.allow(message.from)) {
      await this.noticeThrottled(message.from)
      return
    }
    this.throttledPeers.delete(message.from)
    await this.push(message.text, chatMeta(message))
  }

  private async noticeThrottled(peer: string): Promise<void> {
    if (this.throttledPeers.has(peer)) return
    this.throttledPeers.add(peer)
    await this.push(
      `More messages from @${peer} arrived too quickly; they are stored without notifying you. Read them with the history tool.`,
      { kind: 'system', from: peer },
    )
  }

  private onError(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error)
    console.error(`[team-peers] ${text}`)
    if (Date.now() - this.lastErrorNoticeAt < ERROR_NOTICE_INTERVAL_MS) return
    this.lastErrorNoticeAt = Date.now()
    void this.push(
      `team-peers cannot reach Service Bus: ${text}. Check az login and the namespace settings.`,
      {
        kind: 'system',
      },
    ).catch(() => undefined)
  }

  private prune(): void {
    const cutoff = Date.now() - PRESENCE_TTL_MS
    for (const [handle, entry] of this.roster) if (entry.lastSeen < cutoff) this.roster.delete(handle)
  }

  private persistPeers(): void {
    this.prune()
    this.store.writePeers({
      writtenAt: Date.now(),
      listenerPid: process.pid,
      peers: [...this.roster.values()],
    })
  }
}
