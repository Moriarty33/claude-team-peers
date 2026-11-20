import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  newChat,
  normalizeChannel,
  normalizeHandle,
  parseEnvelope,
  sanitizeText,
} from '../server/protocol.ts'

const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e)

describe('sanitizeText', () => {
  it('drops control, ANSI escape and bidi override characters', () => {
    assert.equal(sanitizeText(`ok\u001b[31mred${RIGHT_TO_LEFT_OVERRIDE}evil\u0000`), 'ok[31mredevil')
  })

  it('keeps newlines and tabs', () => {
    assert.equal(sanitizeText('a\nb\tc'), 'a\nb\tc')
  })

  it('cuts text to the limit', () => {
    assert.equal(sanitizeText('abcdef', 3), 'abc')
  })
})

describe('normalizeHandle and normalizeChannel', () => {
  it('accepts @ and # prefixes and lowercases', () => {
    assert.equal(normalizeHandle('@Bob'), 'bob')
    assert.equal(normalizeChannel('#Feat-123'), 'feat-123')
  })

  it('rejects names with spaces or quotes', () => {
    assert.throws(() => normalizeHandle("bob' OR 1=1"))
    assert.throws(() => normalizeChannel('has space'))
  })
})

describe('newChat', () => {
  it('requires exactly one of to or channel', () => {
    assert.throws(() => newChat('alice', { text: 'hi' }))
    assert.throws(() => newChat('alice', { text: 'hi', to: 'bob', channel: 'general' }))
  })

  it('rejects empty text after sanitizing', () => {
    assert.throws(() => newChat('alice', { text: ' \u0000 ', to: 'bob' }))
  })

  it('builds a direct message', () => {
    const message = newChat('alice', { text: 'review PR 12', to: '@Bob', replyTo: 'm1' })
    assert.equal(message.to, 'bob')
    assert.equal(message.channel, undefined)
    assert.equal(message.replyTo, 'm1')
  })
})

describe('parseEnvelope', () => {
  const chat = { v: 1, kind: 'chat', id: 'm1', from: 'alice', ts: 1, text: 'hi', channel: 'general' }

  it('parses a valid chat message', () => {
    assert.deepEqual(parseEnvelope(chat), { ...chat, to: undefined, replyTo: undefined })
  })

  it('rejects unknown versions, bad senders and missing targets', () => {
    assert.equal(parseEnvelope({ ...chat, v: 2 }), null)
    assert.equal(parseEnvelope({ ...chat, from: 'Not Valid' }), null)
    assert.equal(parseEnvelope({ ...chat, channel: undefined }), null)
    assert.equal(parseEnvelope({ ...chat, to: 'bob' }), null)
    assert.equal(parseEnvelope('not an object'), null)
  })

  it('parses presence and drops presence without startedAt', () => {
    const presence = {
      v: 1,
      kind: 'presence',
      id: 'p1',
      from: 'bob',
      ts: 2,
      status: { startedAt: 1, repo: 'api' },
    }
    assert.equal(parseEnvelope(presence)?.kind, 'presence')
    assert.equal(parseEnvelope({ ...presence, status: { repo: 'api' } }), null)
  })
})
