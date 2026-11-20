import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeHandle } from './protocol.ts'

export type Config = {
  handle: string
  topic: string
  namespace?: string
  connectionString?: string
  listen: boolean
  stateDir: string
  messageTtlMs: number
}

type FileConfig = Partial<{
  handle: string
  topic: string
  namespace: string
  connectionString: string
  messageTtlHours: number
}>

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEAM_PEERS_STATE_DIR || join(homedir(), '.claude', 'team-peers')
}

function readFileConfig(root: string): FileConfig {
  try {
    return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as FileConfig
  } catch {
    return {}
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = stateRoot(env)
  const file = readFileConfig(root)
  const handle = normalizeHandle(env.TEAM_PEERS_HANDLE || file.handle || '')

  const namespace = env.TEAM_PEERS_NAMESPACE || file.namespace
  const connectionString = env.TEAM_PEERS_CONNECTION_STRING || file.connectionString
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

  const ttlHours = Number(env.TEAM_PEERS_MESSAGE_TTL_HOURS || file.messageTtlHours || 24)
  if (!Number.isFinite(ttlHours) || ttlHours <= 0)
    throw new Error('TEAM_PEERS_MESSAGE_TTL_HOURS must be positive')

  return {
    handle,
    topic: env.TEAM_PEERS_TOPIC || file.topic || 'team-peers',
    namespace,
    connectionString,
    listen: env.TEAM_PEERS_LISTEN === '1',
    stateDir: join(root, handle),
    messageTtlMs: ttlHours * 3_600_000,
  }
}
