import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { loadConfig } from '../server/config.ts'

const root = mkdtempSync(join(tmpdir(), 'team-peers-config-'))
after(() => rmSync(root, { recursive: true, force: true }))

function withEnvFile(lines: string[]): string {
  const dir = mkdtempSync(join(root, 'state-'))
  writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`)
  chmodSync(join(dir, '.env'), 0o600)
  return dir
}

const AZURE = [
  'TEAM_PEERS_HANDLE=alice',
  'TEAM_PEERS_NAMESPACE=ns-example',
  'TEAM_PEERS_KEY_VAULT_URL=https://kv-example.vault.azure.net',
  'UNRELATED_SECRET=ignored',
]

describe('loadConfig', () => {
  it('reads the .env file in the state directory', () => {
    const dir = withEnvFile(AZURE)
    const config = loadConfig({ TEAM_PEERS_STATE_DIR: dir })
    assert.equal(config.handle, 'alice')
    assert.equal(config.namespace, 'ns-example')
    assert.deepEqual(config.encryption, {
      kind: 'keyvault',
      vaultUrl: 'https://kv-example.vault.azure.net',
      keyName: 'team-peers',
    })
    assert.equal(config.stateDir, join(dir, 'alice'))
    assert.equal(config.listen, false)
  })

  it('lets the process environment override the file, and only it set the listener', () => {
    const dir = withEnvFile([...AZURE, 'TEAM_PEERS_LISTEN=1'])
    const config = loadConfig({ TEAM_PEERS_STATE_DIR: dir, TEAM_PEERS_HANDLE: 'bob' })
    assert.equal(config.handle, 'bob')
    assert.equal(config.listen, false)
    assert.equal(loadConfig({ TEAM_PEERS_STATE_DIR: dir, TEAM_PEERS_LISTEN: '1' }).listen, true)
  })

  it('requires Key Vault outside the emulator', () => {
    const dir = withEnvFile(['TEAM_PEERS_HANDLE=alice', 'TEAM_PEERS_NAMESPACE=ns-example'])
    assert.throws(() => loadConfig({ TEAM_PEERS_STATE_DIR: dir }), /KEY_VAULT_URL/)
  })

  it('refuses a real connection string and a local key outside the emulator', () => {
    const dir = withEnvFile([
      'TEAM_PEERS_HANDLE=alice',
      'TEAM_PEERS_CONNECTION_STRING=Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKey=x',
    ])
    assert.throws(() => loadConfig({ TEAM_PEERS_STATE_DIR: dir }), /emulator/)
    const local = withEnvFile([
      'TEAM_PEERS_HANDLE=alice',
      'TEAM_PEERS_NAMESPACE=ns-example',
      'TEAM_PEERS_LOCAL_KEY=AAAA',
    ])
    assert.throws(() => loadConfig({ TEAM_PEERS_STATE_DIR: local }), /KEY_VAULT_URL/)
  })
})
