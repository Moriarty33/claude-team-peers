import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { loadConfig, resolveConfig } from '../server/config.ts'

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
    assert.equal(resolveConfig(config, 'alice').stateDir, join(dir, 'alice'))
    assert.equal(config.listen, false)
    assert.equal(config.registration, undefined)
  })

  it('leaves the handle to the Azure sign-in and reads the registration target', () => {
    const dir = withEnvFile([
      'TEAM_PEERS_NAMESPACE=ns-example',
      'TEAM_PEERS_KEY_VAULT_URL=https://kv-example.vault.azure.net',
      'TEAM_PEERS_AZURE_SUBSCRIPTION_ID=sub-1',
      'TEAM_PEERS_RESOURCE_GROUP=rg-1',
    ])
    const config = loadConfig({ TEAM_PEERS_STATE_DIR: dir })
    assert.equal(config.handle, undefined)
    assert.deepEqual(config.registration, { subscriptionId: 'sub-1', resourceGroup: 'rg-1' })
  })

  it('wants the registration subscription and resource group together', () => {
    const dir = withEnvFile([...AZURE, 'TEAM_PEERS_AZURE_SUBSCRIPTION_ID=sub-1'])
    assert.throws(() => loadConfig({ TEAM_PEERS_STATE_DIR: dir }), /RESOURCE_GROUP/)
  })

  it('needs an explicit handle for the emulator', () => {
    const dir = withEnvFile([
      'TEAM_PEERS_CONNECTION_STRING=Endpoint=sb://localhost;UseDevelopmentEmulator=true;',
      'TEAM_PEERS_LOCAL_KEY=AAAA',
    ])
    assert.throws(() => loadConfig({ TEAM_PEERS_STATE_DIR: dir }), /HANDLE/)
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
