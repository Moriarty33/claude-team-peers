import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { normalizeHandle } from './protocol.ts'

export type Encryption =
  | { kind: 'keyvault'; vaultUrl: string; keyName: string }
  | { kind: 'local'; key: string }

export type Registration = { subscriptionId: string; resourceGroup: string }

export type Config = {
  handle: string
  topic: string
  namespace?: string
  connectionString?: string
  encryption: Encryption
  registration?: Registration
  listen: boolean
  stateDir: string
  messageTtlMs: number
}

/** What the settings say before the handle is known; the handle may come from the Azure sign-in. */
export type LoadedConfig = Omit<Config, 'handle' | 'stateDir'> & { handle?: string; stateRoot: string }

type Settings = Record<string, string>

const PREFIX = 'TEAM_PEERS_'

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEAM_PEERS_STATE_DIR || join(homedir(), '.claude', 'team-peers')
}

function ownSettings(source: Record<string, string | undefined>): Settings {
  const settings: Settings = {}
  for (const [key, value] of Object.entries(source))
    if (key.startsWith(PREFIX) && value) settings[key] = value
  return settings
}

function readEnvFile(root: string): Settings {
  const path = join(root, '.env')
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    console.error(`[team-peers] ${path} is readable by other users; run chmod 600 on it`)
  }
  return ownSettings(parseEnv(content) as Record<string, string | undefined>)
}

function encryptionFrom(settings: Settings, emulator: boolean): Encryption {
  const vaultUrl = settings.TEAM_PEERS_KEY_VAULT_URL
  if (vaultUrl) return { kind: 'keyvault', vaultUrl, keyName: settings.TEAM_PEERS_KEY_NAME || 'team-peers' }
  const key = settings.TEAM_PEERS_LOCAL_KEY
  if (key && emulator) return { kind: 'local', key }
  throw new Error(
    emulator
      ? 'Set TEAM_PEERS_LOCAL_KEY (32 random bytes, base64) or TEAM_PEERS_KEY_VAULT_URL to encrypt messages'
      : 'Set TEAM_PEERS_KEY_VAULT_URL: messages are encrypted with the team key in Key Vault',
  )
}

function registrationFrom(settings: Settings): Registration | undefined {
  const subscriptionId = settings.TEAM_PEERS_AZURE_SUBSCRIPTION_ID
  const resourceGroup = settings.TEAM_PEERS_RESOURCE_GROUP
  if (Boolean(subscriptionId) !== Boolean(resourceGroup)) {
    throw new Error('Set both TEAM_PEERS_AZURE_SUBSCRIPTION_ID and TEAM_PEERS_RESOURCE_GROUP, or neither')
  }
  return subscriptionId && resourceGroup ? { subscriptionId, resourceGroup } : undefined
}

export function resolveConfig(loaded: LoadedConfig, handle: string): Config {
  const { stateRoot: root, handle: _ignored, ...rest } = loaded
  return { ...rest, handle, stateDir: join(root, handle) }
}

/** Reads ~/.claude/team-peers/.env; variables in the process environment win over the file. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const root = stateRoot(env)
  const settings = { ...readEnvFile(root), ...ownSettings(env) }
  const handle = settings.TEAM_PEERS_HANDLE ? normalizeHandle(settings.TEAM_PEERS_HANDLE) : undefined

  const namespace = settings.TEAM_PEERS_NAMESPACE
  const connectionString = settings.TEAM_PEERS_CONNECTION_STRING
  if (connectionString && !handle) throw new Error('Set TEAM_PEERS_HANDLE when using the emulator')
  if (connectionString && !/UseDevelopmentEmulator=true/i.test(connectionString)) {
    throw new Error(
      'Connection strings are accepted only for the local emulator; use TEAM_PEERS_NAMESPACE with az login',
    )
  }
  if (!namespace && !connectionString) {
    throw new Error(
      'Set TEAM_PEERS_NAMESPACE (Entra ID through az login) or TEAM_PEERS_CONNECTION_STRING (emulator)',
    )
  }

  const ttlHours = Number(settings.TEAM_PEERS_MESSAGE_TTL_HOURS || 24)
  if (!Number.isFinite(ttlHours) || ttlHours <= 0)
    throw new Error('TEAM_PEERS_MESSAGE_TTL_HOURS must be positive')

  return {
    handle,
    topic: settings.TEAM_PEERS_TOPIC || 'team-peers',
    namespace,
    connectionString,
    encryption: encryptionFrom(settings, Boolean(connectionString)),
    registration: connectionString ? undefined : registrationFrom(settings),
    listen: env.TEAM_PEERS_LISTEN === '1',
    stateRoot: root,
    messageTtlMs: ttlHours * 3_600_000,
  }
}
