import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Store } from '../server/store.ts'

const root = mkdtempSync(join(tmpdir(), 'team-peers-store-'))
after(() => rmSync(root, { recursive: true, force: true }))

const entry = (id: string, overrides: object) => ({
  v: 1 as const,
  kind: 'chat' as const,
  id,
  from: 'alice',
  ts: 1,
  text: id,
  direction: 'in' as const,
  ...overrides,
})

describe('Store', () => {
  it('starts in #general with notify=mentions and saves changes', () => {
    const store = new Store(join(root, 'channels'))
    assert.deepEqual(store.channels(), { general: 'mentions' })
    store.saveChannels({ general: 'all', 'feat-1': 'mentions' })
    assert.deepEqual(new Store(join(root, 'channels')).channels(), { general: 'all', 'feat-1': 'mentions' })
  })

  it('filters history by channel and by peer, newest last', () => {
    const store = new Store(join(root, 'history'))
    store.appendHistory(entry('a', { channel: 'general' }))
    store.appendHistory(entry('b', { to: 'bob' }))
    store.appendHistory(entry('c', { from: 'bob', to: 'alice', direction: 'out' }))
    store.appendHistory(entry('d', { channel: 'feat-1', from: 'carol' }))
    assert.deepEqual(
      store.readHistory({ channel: 'general', limit: 10 }).map((e) => e.id),
      ['a'],
    )
    assert.deepEqual(
      store.readHistory({ peer: 'bob', limit: 10 }).map((e) => e.id),
      ['b', 'c'],
    )
    assert.deepEqual(
      store.readHistory({ limit: 2 }).map((e) => e.id),
      ['c', 'd'],
    )
  })

  it('lets only one live listener hold the lock', () => {
    const store = new Store(join(root, 'lock'))
    assert.ok(store.acquireListener())
    assert.equal(store.listenerPid(), process.pid)
    store.releaseListener()
    assert.equal(store.listenerPid(), undefined)
  })
})
