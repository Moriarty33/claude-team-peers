import type { Bus } from './bus.ts'
import type { Config } from './config.ts'
import type { Listener } from './listener.ts'
import { MAX_SUMMARY, newChat, normalizeChannel, normalizeHandle, sanitizeText } from './protocol.ts'
import { type HistoryEntry, isProcessAlive, type PeerEntry, type Store } from './store.ts'

export type ToolContext = { config: Config; bus: Bus; store: Store; listener?: Listener }
type Args = Record<string, unknown>

const STALE_PEERS_MS = 2 * 60_000

export const TOOLS = [
  {
    name: 'send',
    description:
      'Send a message to a teammate (to=<handle>) or to a channel (channel=<name>). Pass reply_to=<message_id> when answering.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text, up to 4000 characters' },
        to: { type: 'string', description: 'Teammate handle for a direct message' },
        channel: { type: 'string', description: 'Channel name, for example general' },
        reply_to: { type: 'string', description: 'message_id of the message you answer' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_peers',
    description:
      'List teammates whose Claude Code listener is online, with repo, branch and what they work on.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'history',
    description: 'Show recent messages, optionally only one channel or only messages with one teammate.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        peer: { type: 'string', description: 'Teammate handle' },
        limit: { type: 'number', description: '1-100, default 20' },
      },
    },
  },
  {
    name: 'channels',
    description:
      'List, join or leave channels. notify=all pushes every message; notify=mentions pushes only @mentions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'join', 'leave'] },
        channel: { type: 'string' },
        notify: { type: 'string', enum: ['all', 'mentions'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_status',
    description: 'Tell teammates in one line what you are working on. Shown in their list_peers.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'Up to 200 characters' } },
      required: ['summary'],
    },
  },
] as const

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

function timestamp(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function formatEntry(entry: HistoryEntry): string {
  const where = entry.channel ? `#${entry.channel} @${entry.from}` : `@${entry.from} -> @${entry.to}`
  const reply = entry.replyTo ? ` (reply to ${entry.replyTo})` : ''
  return `[${timestamp(entry.ts)}] ${where}${reply}: ${entry.text} (id ${entry.id})`
}

function formatPeer(peer: PeerEntry): string {
  const place = [peer.status.repo, peer.status.branch].filter(Boolean).join(' on ') || 'no repo'
  const summary = peer.status.summary ? ` - "${peer.status.summary}"` : ''
  const seen = Math.round((Date.now() - peer.lastSeen) / 1000)
  return `@${peer.handle}: ${place}${summary} (seen ${seen}s ago)`
}

async function send(ctx: ToolContext, args: Args): Promise<string> {
  const message = newChat(ctx.config.handle, {
    text: String(args.text ?? ''),
    to: optionalString(args.to),
    channel: optionalString(args.channel),
    replyTo: optionalString(args.reply_to),
  })
  if (message.to === ctx.config.handle) throw new Error('You cannot send a message to yourself')
  let note = ''
  const prefs = ctx.store.channels()
  if (message.channel && !prefs[message.channel]) {
    ctx.store.saveChannels({ ...prefs, [message.channel]: 'mentions' })
    note = ` Joined #${message.channel} with notify=mentions so you see replies that mention you.`
  }
  await ctx.bus.send(message)
  ctx.store.appendHistory({ ...message, direction: 'out' })
  return `Sent ${message.id} to ${message.channel ? `#${message.channel}` : `@${message.to}`}.${note}`
}

function listPeers(ctx: ToolContext): string {
  if (ctx.listener) return ctx.listener.peers().map(formatPeer).join('\n') || 'Nobody else is online.'
  const snapshot = ctx.store.readPeers()
  const fresh =
    snapshot && Date.now() - snapshot.writtenAt < STALE_PEERS_MS && isProcessAlive(snapshot.listenerPid)
  const lines = snapshot?.peers.map(formatPeer).join('\n') || 'Nobody else is online.'
  return fresh ? lines : `Your listener tab is not running, so this list may be out of date.\n${lines}`
}

function history(ctx: ToolContext, args: Args): string {
  const channel = optionalString(args.channel)
  const peer = optionalString(args.peer)
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
  const entries = ctx.store.readHistory({
    channel: channel ? normalizeChannel(channel) : undefined,
    peer: peer ? normalizeHandle(peer) : undefined,
    limit,
  })
  return entries.map(formatEntry).join('\n') || 'No messages yet.'
}

function channels(ctx: ToolContext, args: Args): string {
  const prefs = { ...ctx.store.channels() }
  const action = String(args.action)
  if (action === 'join' || action === 'leave') {
    const channel = normalizeChannel(String(args.channel ?? ''))
    if (action === 'join') prefs[channel] = args.notify === 'all' ? 'all' : 'mentions'
    else delete prefs[channel]
    ctx.store.saveChannels(prefs)
  } else if (action !== 'list') {
    throw new Error('action must be list, join or leave')
  }
  const lines = Object.entries(prefs).map(([name, mode]) => `#${name} (notify=${mode})`)
  return lines.join('\n') || 'You have not joined any channel.'
}

async function setStatus(ctx: ToolContext, args: Args): Promise<string> {
  const summary = sanitizeText(String(args.summary ?? ''), MAX_SUMMARY).trim()
  ctx.store.saveSummary(summary)
  await ctx.listener?.beat()
  return summary ? `Status set: ${summary}` : 'Status cleared.'
}

export async function callTool(ctx: ToolContext, name: string, args: Args): Promise<string> {
  switch (name) {
    case 'send':
      return send(ctx, args)
    case 'list_peers':
      return listPeers(ctx)
    case 'history':
      return history(ctx, args)
    case 'channels':
      return channels(ctx, args)
    case 'set_status':
      return setStatus(ctx, args)
    default:
      throw new Error(`Unknown tool ${name}`)
  }
}
