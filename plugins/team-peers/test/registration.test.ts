import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeClaims, handleFromPrincipal } from '../server/identity.ts'
import {
  ensureSubscription,
  inboxFilter,
  ownerTag,
  type SubscriptionAdmin,
  type SubscriptionInfo,
} from '../server/registration.ts'

describe('handleFromPrincipal', () => {
  it('uses the part before @ and replaces separators with dashes', () => {
    assert.equal(handleFromPrincipal('Alice.Smith@example.com'), 'alice-smith')
    assert.equal(handleFromPrincipal('bob@example.com'), 'bob')
  })

  it('reads guest and federated sign-in names', () => {
    assert.equal(handleFromPrincipal('john.doe_contoso.com#EXT#@fabrikam.onmicrosoft.com'), 'john-doe')
    assert.equal(handleFromPrincipal('live.com#carol@outlook.com'), 'carol')
  })

  it('returns undefined when nothing usable is left', () => {
    assert.equal(handleFromPrincipal('@example.com'), undefined)
    assert.equal(handleFromPrincipal('x@example.com'), undefined)
  })

  it('caps the handle at 32 characters without a trailing dash', () => {
    const handle = handleFromPrincipal(`${'a'.repeat(31)}.b@example.com`)
    assert.equal(handle, 'a'.repeat(31))
  })
})

describe('decodeClaims', () => {
  it('reads the JWT payload', () => {
    const payload = Buffer.from(JSON.stringify({ upn: 'a@b.c', oid: 'o1' })).toString('base64url')
    assert.deepEqual(decodeClaims(`header.${payload}.signature`), { upn: 'a@b.c', oid: 'o1' })
    assert.throws(() => decodeClaims('not-a-jwt'))
  })
})

function fakeAdmin(subscriptions: Record<string, SubscriptionInfo>, rules: Record<string, string[]> = {}) {
  const writes: string[] = []
  const admin: SubscriptionAdmin = {
    getSubscription: async (name) => subscriptions[name],
    putSubscription: async (name, info) => {
      writes.push(`put ${name} ${info.userMetadata}`)
      subscriptions[name] = info
    },
    hasRule: async (subscription, rule) => (rules[subscription] ?? []).includes(rule),
    putSqlRule: async (subscription, rule, sql) => {
      writes.push(`rule ${subscription} ${rule} ${sql}`)
      rules[subscription] = [...(rules[subscription] ?? []), rule]
    },
    deleteRule: async (subscription, rule) => {
      writes.push(`delete ${subscription} ${rule}`)
    },
  }
  return { admin, writes, subscriptions }
}

describe('ensureSubscription', () => {
  it('creates a missing subscription owned by the caller with the inbox filter', async () => {
    const { admin, writes, subscriptions } = fakeAdmin({})
    assert.equal(await ensureSubscription(admin, 'alice', 'oid-a', 'PT24H'), 'created')
    assert.equal(subscriptions.alice?.userMetadata, ownerTag('oid-a'))
    assert.equal(subscriptions.alice?.defaultMessageTimeToLive, 'PT24H')
    assert.deepEqual(writes, [
      `put alice ${ownerTag('oid-a')}`,
      `rule alice inbox ${inboxFilter('alice')}`,
      'delete alice $Default',
    ])
  })

  it('leaves the caller’s own subscription alone', async () => {
    const { admin, writes } = fakeAdmin({ alice: { userMetadata: ownerTag('oid-a') } }, { alice: ['inbox'] })
    assert.equal(await ensureSubscription(admin, 'alice', 'oid-a', 'PT24H'), 'existing')
    assert.deepEqual(writes, ['delete alice $Default'])
  })

  it('adopts an unowned subscription and keeps its settings', async () => {
    const existing = { lockDuration: 'PT2M', maxDeliveryCount: 7, defaultMessageTimeToLive: 'P1D' }
    const { admin, subscriptions } = fakeAdmin({ alice: existing }, { alice: ['inbox'] })
    assert.equal(await ensureSubscription(admin, 'alice', 'oid-a', 'PT24H'), 'claimed')
    assert.deepEqual(subscriptions.alice, { ...existing, userMetadata: ownerTag('oid-a') })
  })

  it('refuses a handle that belongs to another account and writes nothing', async () => {
    const { admin, writes } = fakeAdmin({ alice: { userMetadata: ownerTag('oid-b') } })
    await assert.rejects(ensureSubscription(admin, 'alice', 'oid-a', 'PT24H'), /another account/)
    assert.deepEqual(writes, [])
  })
})
