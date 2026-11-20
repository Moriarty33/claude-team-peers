export type HookInput = { tool_name?: string; permission_mode?: string }
export type Decision = { permissionDecision: 'ask' | 'deny'; permissionDecisionReason: string }

const LOCAL_READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'ToolSearch',
  'AskUserQuestion',
])

const PEER_READ_TOOL = /^mcp__(?:plugin_team-peers_)?team-peers__(?:list_peers|history|channels)$/
const UNATTENDED_MODES = new Set(['bypassPermissions', 'dontAsk'])

export function decide(input: HookInput, env: NodeJS.ProcessEnv): Decision | null {
  if (env.TEAM_PEERS_LISTEN !== '1') return null
  if (input.permission_mode && UNATTENDED_MODES.has(input.permission_mode)) {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason:
        'team-peers: the listener tab must run with permission prompts; restart it without bypass or dontAsk mode',
    }
  }
  const tool = input.tool_name ?? ''
  if (LOCAL_READ_TOOLS.has(tool) || PEER_READ_TOOL.test(tool)) return null
  return {
    permissionDecision: 'ask',
    permissionDecisionReason: 'team-peers listener: confirm every action and every outgoing message',
  }
}
