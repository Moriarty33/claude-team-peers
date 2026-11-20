import { decide, type HookInput } from './policy.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

if (process.env.TEAM_PEERS_LISTEN === '1') {
  let input: HookInput = {}
  try {
    input = JSON.parse(await readStdin()) as HookInput
  } catch {
    input = {}
  }
  const decision = decide(input, process.env)
  if (decision) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } }))
  }
}
