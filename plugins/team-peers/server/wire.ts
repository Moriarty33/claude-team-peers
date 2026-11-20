import { isSealed, type Sealed, type Sealer } from './crypto.ts'
import { type Envelope, parseEnvelope } from './protocol.ts'

export type WireMessage = { body: { v: 2; sealed: Sealed }; applicationProperties: Record<string, string> }

// The subscription filter needs the recipient in clear text; binding it as AAD stops it being swapped.
export function aadFor(recipient: string | undefined): string {
  return `team-peers/v2|recipient=${recipient ?? ''}`
}

function recipientOf(envelope: Envelope): string | undefined {
  return envelope.kind === 'chat' ? envelope.to : undefined
}

export async function toWire(sealer: Sealer, envelope: Envelope): Promise<WireMessage> {
  const recipient = recipientOf(envelope)
  const sealed = await sealer.seal(envelope, aadFor(recipient))
  return { body: { v: 2, sealed }, applicationProperties: recipient ? { recipient } : {} }
}

/** Returns null for anything that is not a well-formed v2 message; throws when decryption fails. */
export async function fromWire(
  sealer: Sealer,
  body: unknown,
  properties: Record<string, unknown> | undefined,
): Promise<Envelope | null> {
  if (!body || typeof body !== 'object') return null
  const raw = body as Record<string, unknown>
  if (raw.v !== 2 || !isSealed(raw.sealed)) return null
  const recipient = typeof properties?.recipient === 'string' ? properties.recipient : undefined
  const envelope = parseEnvelope(await sealer.open(raw.sealed, aadFor(recipient)))
  if (!envelope || recipientOf(envelope) !== recipient) return null
  return envelope
}
