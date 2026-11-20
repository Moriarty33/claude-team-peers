import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChatMessage } from '../server/protocol.ts'
import { mentions, RateLimiter, route } from '../server/router.ts'

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  v: 1,
  kind: 'chat',
  id: 'm1',
  from: 'alice',
  ts: 1,
  text: 'hello',
  ...overrides,
})

describe('mentions', () => {
  it('matches the handle and broadcast names as whole words', () => {
    assert.ok(mentions('@bob please look', 'bob'))
    assert.ok(mentions('ping (@bob)', 'bob'))
    assert.ok(mentions('@here anyone?', 'bob'))
    assert.ok(!mentions('@bobby please look', 'bob'))
    assert.ok(!mentions('@bob-x please look', 'bob'))
    assert.ok(!mentions('mail bob@example.com', 'bob'))
  })
})

describe('route', () => {
  const prefs = { general: 'mentions', 'feat-1': 'all' } as const

  it('pushes direct messages to me and ignores the rest', () => {
    assert.equal(route(message({ to: 'bob' }), 'bob', prefs), 'push')
    assert.equal(route(message({ to: 'carol' }), 'bob', prefs), 'ignore')
  })

  it('ignores my own messages', () => {
    assert.equal(route(message({ from: 'bob', to: 'bob' }), 'bob', prefs), 'ignore')
  })

  it('follows the notify mode of joined channels', () => {
    assert.equal(route(message({ channel: 'feat-1' }), 'bob', prefs), 'push')
    assert.equal(route(message({ channel: 'general' }), 'bob', prefs), 'store')
    assert.equal(route(message({ channel: 'general', text: '@bob ?' }), 'bob', prefs), 'push')
    assert.equal(route(message({ channel: 'other' }), 'bob', prefs), 'ignore')
  })
})

describe('RateLimiter', () => {
  it('allows the limit per key inside the window, then recovers', () => {
    let now = 0
    const limiter = new RateLimiter(2, 1000, () => now)
    assert.ok(limiter.allow('alice'))
    assert.ok(limiter.allow('alice'))
    assert.ok(!limiter.allow('alice'))
    assert.ok(limiter.allow('carol'))
    now = 1500
    assert.ok(limiter.allow('alice'))
  })
})
