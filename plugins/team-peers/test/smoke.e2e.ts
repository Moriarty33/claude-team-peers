import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AzureCliCredential } from '@azure/identity'
import { ServiceBusClient } from '@azure/service-bus'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The emulator's documented development key, not a secret.
const EMULATOR =
  'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
const SERVER = fileURLToPath(new URL('../server/index.ts', import.meta.url))
const TOPIC = process.env.TEAM_PEERS_TOPIC ?? 'team-peers'
const NAMESPACE = process.env.TEAM_PEERS_NAMESPACE
const [A, B] = (process.env.TEAM_PEERS_SMOKE_HANDLES ?? 'alice,bob').split(',') as [string, string]
const root = mkdtempSync(join(tmpdir(), 'team-peers-smoke-'))

const target: Record<string, string> = NAMESPACE
  ? { TEAM_PEERS_NAMESPACE: NAMESPACE, TEAM_PEERS_KEY_VAULT_URL: process.env.TEAM_PEERS_KEY_VAULT_URL ?? '' }
  : { TEAM_PEERS_CONNECTION_STRING: EMULATOR, TEAM_PEERS_LOCAL_KEY: randomBytes(32).toString('base64') }

type ChannelEvent = { content: string; meta: Record<string, string> }
type Peer = { client: Client; events: ChannelEvent[]; call(name: string, args?: object): Promise<string> }

async function startPeer(handle: string): Promise<Peer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...getDefaultEnvironment(),
      ...target,
      TEAM_PEERS_HANDLE: handle,
      TEAM_PEERS_TOPIC: TOPIC,
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

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 30_000) {
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

async function peekStoredBodies(subscription: string): Promise<string[]> {
  const client = NAMESPACE
    ? new ServiceBusClient(`${NAMESPACE}.servicebus.windows.net`, new AzureCliCredential())
    : new ServiceBusClient(EMULATOR)
  try {
    const messages = await client.createReceiver(TOPIC, subscription).peekMessages(50)
    return messages.map((message) =>
      JSON.stringify({ body: message.body, props: message.applicationProperties }),
    )
  } finally {
    await client.close()
  }
}

async function main(): Promise<void> {
  const a = await startPeer(A)
  let b: Peer | undefined
  try {
    await a.call('send', { to: B, text: 'offline secret for b' })
    const stored = await waitFor('the message to wait in the subscription', async () => {
      const bodies = await peekStoredBodies(B)
      return bodies.find((body) => body.includes('"sealed"'))
    })
    assert.ok(
      !stored.includes('offline secret') && !stored.includes(`"${A}"`),
      'stored body must be ciphertext',
    )
    console.log(
      'ok encryption: a waiting message is ciphertext in Service Bus, only the recipient is visible',
    )

    b = await startPeer(B)
    const peer = b
    await waitFor('offline delivery', findEvent(peer, 'offline secret for b'))
    console.log('ok offline: the message waits for the listener and arrives decrypted')

    await waitFor(`${B} to see ${A} online`, async () =>
      (await peer.call('list_peers')).includes(`@${A}`) ? 1 : 0,
    )
    console.log(`ok presence: @${B} sees @${A} online`)

    await peer.call('channels', { action: 'join', channel: 'feat-1', notify: 'all' })
    await a.call('send', { channel: '#feat-1', text: 'please review PR 12' })
    const featEvent = await waitFor('channel push', findEvent(peer, 'please review PR 12'))
    assert.equal(featEvent.meta.channel, 'feat-1')
    assert.equal(featEvent.meta.from, A)
    console.log('ok channel: notify=all pushes every message')

    await a.call('send', { channel: 'general', text: 'quiet general note' })
    await a.call('send', { channel: 'general', text: `@${B} loud general ping` })
    await waitFor('mention push', findEvent(peer, 'loud general ping'))
    assert.equal(
      findEvent(peer, 'quiet general note')(),
      undefined,
      'a message without a mention must not push',
    )
    assert.match(await peer.call('history', { channel: 'general' }), /quiet general note/)
    console.log('ok mentions: #general pushes only mentions, the rest lands in history')

    await a.call('send', { to: B, text: 'direct question' })
    const direct = await waitFor('direct push', findEvent(peer, 'direct question'))
    assert.equal(direct.meta.direct, 'true')
    await peer.call('send', { to: A, text: 'direct answer', reply_to: direct.meta.message_id })
    const answer = await waitFor('reply push', findEvent(a, 'direct answer'))
    assert.equal(answer.meta.reply_to, direct.meta.message_id)
    console.log('ok direct: message and threaded reply both arrive')

    await peer.call('send', { to: 'carol', text: 'not for a' })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    assert.equal(findEvent(a, 'not for a')(), undefined, 'a direct message to someone else must not arrive')
    console.log('ok privacy: a direct message to carol does not reach anyone else')

    await a.client.close()
    const since = Date.now()
    await waitFor(
      `${A} to go offline`,
      async () => ((await peer.call('list_peers')).includes(`@${A}`) ? 0 : 1),
      120_000,
    )
    console.log(
      `ok presence: @${A} disappears ${Math.round((Date.now() - since) / 1000)}s after closing the session`,
    )
  } finally {
    await a.client.close().catch(() => undefined)
    await b?.client.close().catch(() => undefined)
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
