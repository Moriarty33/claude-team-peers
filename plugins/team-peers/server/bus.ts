import type { TokenCredential } from '@azure/identity'
import { ServiceBusClient, type ServiceBusReceiver, type ServiceBusSender } from '@azure/service-bus'
import type { Config } from './config.ts'
import type { Sealer } from './crypto.ts'
import { type Envelope, PRESENCE_TTL_MS } from './protocol.ts'
import { fromWire, toWire } from './wire.ts'

export type Bus = {
  send(envelope: Envelope): Promise<void>
  subscribe(onEnvelope: (envelope: Envelope) => Promise<void>, onError: (error: Error) => void): void
  close(): Promise<void>
}

function fullyQualifiedNamespace(namespace: string): string {
  return namespace.includes('.') ? namespace : `${namespace}.servicebus.windows.net`
}

export function createBus(config: Config, sealer: Sealer, credential: TokenCredential): Bus {
  const client = config.connectionString
    ? new ServiceBusClient(config.connectionString)
    : new ServiceBusClient(fullyQualifiedNamespace(config.namespace ?? ''), credential)
  let sender: ServiceBusSender | undefined
  let receiver: ServiceBusReceiver | undefined

  return {
    async send(envelope) {
      const wire = await toWire(sealer, envelope)
      sender ??= client.createSender(config.topic)
      await sender.sendMessages({
        messageId: envelope.id,
        body: wire.body,
        contentType: 'application/json',
        timeToLive: envelope.kind === 'chat' ? config.messageTtlMs : PRESENCE_TTL_MS,
        applicationProperties: wire.applicationProperties,
      })
    },

    subscribe(onEnvelope, onError) {
      receiver = client.createReceiver(config.topic, config.handle)
      receiver.subscribe({
        processMessage: async (message) => {
          let envelope: Envelope | null
          try {
            envelope = await fromWire(sealer, message.body, message.applicationProperties)
          } catch (error) {
            onError(new Error(`cannot decrypt a message: ${error instanceof Error ? error.message : error}`))
            return
          }
          if (envelope) await onEnvelope(envelope)
        },
        processError: async ({ error }) => onError(error),
      })
    },

    async close() {
      await receiver?.close()
      await sender?.close()
      await client.close()
    },
  }
}
