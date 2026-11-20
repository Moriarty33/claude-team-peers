import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, PeerStatus } from './protocol.ts'

export type NotifyMode = 'all' | 'mentions'
export type ChannelPrefs = Record<string, NotifyMode>
export type HistoryEntry = ChatMessage & { direction: 'in' | 'out' }
export type PeerEntry = { handle: string; status: PeerStatus; lastSeen: number }
export type PeersSnapshot = { writtenAt: number; listenerPid: number; peers: PeerEntry[] }
export type HistoryFilter = { channel?: string; peer?: string; limit: number }

const DEFAULT_CHANNELS: ChannelPrefs = { general: 'mentions' }
const HISTORY_MAX_BYTES = 1_000_000
const HISTORY_KEEP_LINES = 500

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class Store {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  private path(name: string): string {
    return join(this.dir, name)
  }

  channels(): ChannelPrefs {
    return readJson<ChannelPrefs>(this.path('channels.json')) ?? { ...DEFAULT_CHANNELS }
  }

  saveChannels(prefs: ChannelPrefs): void {
    writeJsonAtomic(this.path('channels.json'), prefs)
  }

  summary(): string | undefined {
    return readJson<{ summary?: string }>(this.path('status.json'))?.summary
  }

  saveSummary(summary: string): void {
    writeJsonAtomic(this.path('status.json'), { summary })
  }

  appendHistory(entry: HistoryEntry): void {
    const path = this.path('history.jsonl')
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    if (statSync(path).size > HISTORY_MAX_BYTES) {
      const kept = readFileSync(path, 'utf8').trimEnd().split('\n').slice(-HISTORY_KEEP_LINES)
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 })
      renameSync(tmp, path)
    }
  }

  readHistory(filter: HistoryFilter): HistoryEntry[] {
    let lines: string[]
    try {
      lines = readFileSync(this.path('history.jsonl'), 'utf8').trimEnd().split('\n')
    } catch {
      return []
    }
    const entries: HistoryEntry[] = []
    for (const line of lines) {
      const entry = readLine(line)
      if (!entry) continue
      if (filter.channel && entry.channel !== filter.channel) continue
      if (filter.peer && !isWithPeer(entry, filter.peer)) continue
      entries.push(entry)
    }
    return entries.slice(-filter.limit)
  }

  writePeers(snapshot: PeersSnapshot): void {
    writeJsonAtomic(this.path('peers.json'), snapshot)
  }

  readPeers(): PeersSnapshot | undefined {
    return readJson<PeersSnapshot>(this.path('peers.json'))
  }

  listenerPid(): number | undefined {
    const pid = Number(readJson<{ pid: number }>(this.path('listener.json'))?.pid)
    return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid) ? pid : undefined
  }

  acquireListener(): boolean {
    const current = this.listenerPid()
    if (current && current !== process.pid) return false
    writeJsonAtomic(this.path('listener.json'), { pid: process.pid })
    return true
  }

  releaseListener(): void {
    if (this.listenerPid() === process.pid) rmSync(this.path('listener.json'), { force: true })
  }
}

function readLine(line: string): HistoryEntry | undefined {
  if (!line) return undefined
  try {
    return JSON.parse(line) as HistoryEntry
  } catch {
    return undefined
  }
}

function isWithPeer(entry: HistoryEntry, peer: string): boolean {
  if (entry.channel) return entry.from === peer
  return entry.from === peer || entry.to === peer
}
