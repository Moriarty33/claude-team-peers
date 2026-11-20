import { type Peer, resolvePeer, runIdle, runPeers } from './app.ts'
import { loadConfig } from './config.ts'

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

let peer: Peer | undefined
try {
  peer = await resolvePeer(loadConfig())
} catch (error) {
  await runIdle(reason(error))
}
if (peer) await runPeers(peer)
