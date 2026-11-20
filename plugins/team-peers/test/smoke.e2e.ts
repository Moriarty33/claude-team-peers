import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The emulator's documented development key, not a secret.
const EMULATOR =
  'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
const SERVER = fileURLToPath(new URL('../server/index.ts', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'team-peers-smoke-'))

type ChannelEvent = { content: string; meta: Record<string, string> }
type Peer = { client: Client; events: ChannelEvent[]; call(name: string, args?: object): Promise<string> }

async function startPeer(handle: string): Promise<Peer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...getDefaultEnvironment(),
      TEAM_PEERS_HANDLE: handle,
      TEAM_PEERS_CONNECTION_STRING: process.env.TEAM_PEERS_CONNECTION_STRING ?? EMULATOR,
      TEAM_PEERS_LISTEN: '1',
      TEAM_PEERS_STATE_DIR: root,
      TEAM_PEERS_MESSAGE_TTL_HOURS: '1',
    },
    stderr: 'inherit',
  })
  const client = new Client({ name: `smoke-${handle}`, version: '0.0.0' })
  const events: ChannelEvent[] = []
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === 'notifications/claude/channel')
      events.push(notification.params as ChannelEvent)
  }
  await client.connect(transport)
  const call = async (name: string, args: object = {}) => {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> })
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? ''
    if (result.isError) throw new Error(`${name} failed: ${text}`)
    return text
  }
  return { client, events, call }
}

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 20_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const findEvent = (peer: Peer, text: string) => () =>
  peer.events.find((event) => event.content.includes(text))

async function main(): Promise<void> {
  const alice = await startPeer('alice')
  const bob = await startPeer('bob')
  try {
    await waitFor('bob to see alice online', async () =>
      (await bob.call('list_peers')).includes('@alice') ? 1 : 0,
    )
    console.log('ok presence: bob sees @alice online')

    await bob.call('channels', { action: 'join', channel: 'feat-1', notify: 'all' })
    await alice.call('send', { channel: '#feat-1', text: 'please review PR 12' })
    const featEvent = await waitFor('channel push', findEvent(bob, 'please review PR 12'))
    assert.equal(featEvent.meta.channel, 'feat-1')
    assert.equal(featEvent.meta.from, 'alice')
    console.log('ok channel: notify=all pushes every message')

    await alice.call('send', { channel: 'general', text: 'quiet general note' })
    await alice.call('send', { channel: 'general', text: '@bob loud general ping' })
    await waitFor('mention push', findEvent(bob, 'loud general ping'))
    assert.equal(
      findEvent(bob, 'quiet general note')(),
      undefined,
      'a message without a mention must not push',
    )
    assert.match(await bob.call('history', { channel: 'general' }), /quiet general note/)
    console.log('ok mentions: #general pushes only @bob, the rest lands in history')

    await alice.call('send', { to: 'bob', text: 'direct question' })
    const direct = await waitFor('direct push', findEvent(bob, 'direct question'))
    assert.equal(direct.meta.direct, 'true')
    await bob.call('send', { to: 'alice', text: 'direct answer', reply_to: direct.meta.message_id })
    const answer = await waitFor('reply push', findEvent(alice, 'direct answer'))
    assert.equal(answer.meta.reply_to, direct.meta.message_id)
    console.log('ok direct: message and threaded reply both arrive')

    await bob.call('send', { to: 'carol', text: 'not for alice' })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    assert.equal(
      findEvent(alice, 'not for alice')(),
      undefined,
      'a direct message to someone else must not reach alice',
    )
    console.log('ok privacy: a direct message to carol does not reach alice')

    await alice.client.close()
    const offlineSince = Date.now()
    await waitFor(
      'alice to go offline',
      async () => ((await bob.call('list_peers')).includes('@alice') ? 0 : 1),
      120_000,
    )
    console.log(
      `ok presence: alice disappears ${Math.round((Date.now() - offlineSince) / 1000)}s after closing her session`,
    )
  } finally {
    await alice.client.close().catch(() => undefined)
    await bob.client.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
}

main().then(
  () => console.log('smoke passed'),
  (error) => {
    console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
