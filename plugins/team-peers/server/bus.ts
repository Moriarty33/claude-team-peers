import { AzureCliCredential } from '@azure/identity'
import { ServiceBusClient, type ServiceBusReceiver, type ServiceBusSender } from '@azure/service-bus'
import type { Config } from './config.ts'
import { type Envelope, PRESENCE_TTL_MS, parseEnvelope } from './protocol.ts'

export type Bus = {
  send(envelope: Envelope): Promise<void>
  subscribe(onEnvelope: (envelope: Envelope) => Promise<void>, onError: (error: Error) => void): void
  close(): Promise<void>
}

function fullyQualifiedNamespace(namespace: string): string {
  return namespace.includes('.') ? namespace : `${namespace}.servicebus.windows.net`
}

function applicationProperties(envelope: Envelope): Record<string, string> {
  const properties: Record<string, string> = { kind: envelope.kind, from: envelope.from }
  if (envelope.kind === 'chat') {
    if (envelope.to) properties.recipient = envelope.to
    if (envelope.channel) properties.channel = envelope.channel
  }
  return properties
}

export function createBus(config: Config): Bus {
  const client = config.connectionString
    ? new ServiceBusClient(config.connectionString)
    : new ServiceBusClient(fullyQualifiedNamespace(config.namespace ?? ''), new AzureCliCredential())
  let sender: ServiceBusSender | undefined
  let receiver: ServiceBusReceiver | undefined

  return {
    async send(envelope) {
      sender ??= client.createSender(config.topic)
      await sender.sendMessages({
        messageId: envelope.id,
        body: envelope,
        contentType: 'application/json',
        timeToLive: envelope.kind === 'chat' ? config.messageTtlMs : PRESENCE_TTL_MS,
        applicationProperties: applicationProperties(envelope),
      })
    },

    subscribe(onEnvelope, onError) {
      receiver = client.createReceiver(config.topic, config.handle)
      receiver.subscribe({
        processMessage: async (message) => {
          const envelope = parseEnvelope(message.body)
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
