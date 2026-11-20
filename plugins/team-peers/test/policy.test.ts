import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decide } from '../hooks/policy.ts'

const LISTEN = { TEAM_PEERS_LISTEN: '1' }

describe('decide', () => {
  it('does nothing outside the listener tab', () => {
    assert.equal(decide({ tool_name: 'Bash', permission_mode: 'bypassPermissions' }, {}), null)
  })

  it('asks before commands, edits, web calls, subagents and outgoing messages', () => {
    for (const tool of [
      'Bash',
      'Edit',
      'Write',
      'WebFetch',
      'Agent',
      'mcp__plugin_team-peers_team-peers__send',
    ]) {
      assert.equal(
        decide({ tool_name: tool, permission_mode: 'auto' }, LISTEN)?.permissionDecision,
        'ask',
        tool,
      )
    }
  })

  it('asks before set_status because it is shared with teammates', () => {
    const decision = decide({ tool_name: 'mcp__team-peers__set_status', permission_mode: 'default' }, LISTEN)
    assert.equal(decision?.permissionDecision, 'ask')
  })

  it('lets local reads and peer reads through', () => {
    for (const tool of [
      'Read',
      'Grep',
      'Glob',
      'mcp__team-peers__history',
      'mcp__plugin_team-peers_team-peers__list_peers',
    ]) {
      assert.equal(decide({ tool_name: tool, permission_mode: 'default' }, LISTEN), null, tool)
    }
  })

  it('denies everything when the listener runs without prompts', () => {
    for (const mode of ['bypassPermissions', 'dontAsk']) {
      assert.equal(decide({ tool_name: 'Read', permission_mode: mode }, LISTEN)?.permissionDecision, 'deny')
    }
  })

  it('asks when the tool name is missing', () => {
    assert.equal(decide({}, LISTEN)?.permissionDecision, 'ask')
  })
})

describe('confirm-actions hook script', () => {
  const script = fileURLToPath(new URL('../hooks/confirm-actions.ts', import.meta.url))
  const run = (input: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [script], { input, env: { ...process.env, ...env }, encoding: 'utf8' })

  it('prints an ask decision for Bash in the listener tab', () => {
    const result = run(JSON.stringify({ tool_name: 'Bash', permission_mode: 'auto' }), LISTEN)
    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'ask')
  })

  it('asks on unreadable input', () => {
    const result = run('not json', LISTEN)
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'ask')
  })

  it('prints nothing outside the listener tab', () => {
    const result = run(JSON.stringify({ tool_name: 'Bash' }), { TEAM_PEERS_LISTEN: '' })
    assert.equal(result.stdout, '')
  })
})
