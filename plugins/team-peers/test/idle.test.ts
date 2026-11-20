import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = mkdtempSync(join(tmpdir(), 'team-peers-idle-'))
after(() => rmSync(root, { recursive: true, force: true }))

describe('server without configuration', () => {
  it('starts and offers no tools instead of failing', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../server/index.ts', import.meta.url))],
      env: { ...getDefaultEnvironment(), TEAM_PEERS_STATE_DIR: root },
      stderr: 'ignore',
    })
    const client = new Client({ name: 'idle-test', version: '0.0.0' })
    await client.connect(transport)
    try {
      assert.deepEqual((await client.listTools()).tools, [])
    } finally {
      await client.close()
    }
  })
})
