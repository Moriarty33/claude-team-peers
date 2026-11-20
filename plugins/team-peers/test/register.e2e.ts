import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Needs TEAM_PEERS_NAMESPACE, TEAM_PEERS_KEY_VAULT_URL, TEAM_PEERS_AZURE_SUBSCRIPTION_ID and
// TEAM_PEERS_RESOURCE_GROUP in the environment, and an az login allowed to manage the namespace.
const SERVER = fileURLToPath(new URL('../server/index.ts', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'team-peers-register-'))
type ChannelEvent = { content: string; meta: Record<string, string> }

async function startListener() {
  const passthrough = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.startsWith('TEAM_PEERS_') && key !== 'TEAM_PEERS_HANDLE',
    ),
  ) as Record<string, string>
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...getDefaultEnvironment(), ...passthrough, TEAM_PEERS_LISTEN: '1', TEAM_PEERS_STATE_DIR: root },
    stderr: 'inherit',
  })
  const client = new Client({ name: 'register-e2e', version: '0.0.0' })
  const events: ChannelEvent[] = []
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === 'notifications/claude/channel')
      events.push(notification.params as ChannelEvent)
  }
  await client.connect(transport)
  return { client, events }
}

async function settle(events: ChannelEvent[], ms: number): Promise<ChannelEvent | undefined> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const event = events.find((e) => e.meta.kind === 'system')
    if (event) return event
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return undefined
}

async function main(): Promise<void> {
  const first = await startListener()
  const registered = await settle(first.events, 60_000)
  await first.client.close()
  assert.ok(registered, 'expected a system event about registration')
  assert.match(registered.content, /^Registered as @/, registered.content)
  const handle = /@([a-z0-9-]+)/.exec(registered.content)?.[1]
  console.log(`ok registration: ${registered.content}`)

  const second = await startListener()
  const again = await settle(second.events, 8_000)
  await second.client.close()
  assert.equal(again, undefined, `a second start must not register again: ${again?.content}`)
  console.log('ok registration: a second start reuses the subscription')
  console.log(`handle=${handle}`)
}

main()
  .then(() => console.log('register passed'))
  .catch((error) => {
    console.error(`register failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(() => rmSync(root, { recursive: true, force: true }))
