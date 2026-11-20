import { runIdle, runPeers } from './app.ts'
import { type Config, loadConfig } from './config.ts'

let config: Config | undefined
try {
  config = loadConfig()
} catch (error) {
  await runIdle(error instanceof Error ? error.message : String(error))
}
if (config) await runPeers(config)
