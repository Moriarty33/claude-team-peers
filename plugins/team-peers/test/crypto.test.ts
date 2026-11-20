import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { type KeyWrapper, LocalKeyWrapper, type Sealed, Sealer } from '../server/crypto.ts'
import { isTrustedKid, normalizeVaultUrl } from '../server/keyvault.ts'
import { newChat } from '../server/protocol.ts'
import { aadFor, fromWire, toWire } from '../server/wire.ts'

const localKey = () => randomBytes(32).toString('base64')

function countingWrapper(inner: KeyWrapper) {
  const calls = { wrap: 0, unwrap: 0 }
  const wrapper: KeyWrapper = {
    wrap: (dataKey) => {
      calls.wrap++
      return inner.wrap(dataKey)
    },
    unwrap: (kid, wrappedKey) => {
      calls.unwrap++
      return inner.unwrap(kid, wrappedKey)
    },
  }
  return { wrapper, calls }
}

const flip = (text: string) => {
  const bytes = Buffer.from(text, 'base64')
  bytes[0] = (bytes[0] ?? 0) ^ 1
  return bytes.toString('base64')
}

describe('Sealer', () => {
  it('round-trips a payload between two sealers that share the key', async () => {
    const key = localKey()
    const sealed = await new Sealer(new LocalKeyWrapper(key)).seal({ hello: 'world' }, 'aad')
    assert.ok(!JSON.stringify(sealed).includes('world'))
    assert.deepEqual(await new Sealer(new LocalKeyWrapper(key)).open(sealed, 'aad'), { hello: 'world' })
  })

  it('rejects tampered ciphertext, tag and a different AAD', async () => {
    const key = localKey()
    const sealed = await new Sealer(new LocalKeyWrapper(key)).seal({ n: 1 }, 'aad')
    const reader = new Sealer(new LocalKeyWrapper(key))
    await assert.rejects(reader.open({ ...sealed, ct: flip(sealed.ct) }, 'aad'))
    await assert.rejects(reader.open({ ...sealed, tag: flip(sealed.tag) }, 'aad'))
    await assert.rejects(reader.open(sealed, 'other aad'))
  })

  it('cannot be read with another team key', async () => {
    const sealed = await new Sealer(new LocalKeyWrapper(localKey())).seal({ n: 1 }, 'aad')
    await assert.rejects(new Sealer(new LocalKeyWrapper(localKey())).open(sealed, 'aad'))
  })

  it('wraps one data key per session window and unwraps it once per reader', async () => {
    let now = 0
    const key = localKey()
    const writer = countingWrapper(new LocalKeyWrapper(key))
    const sealer = new Sealer(writer.wrapper, 1000, () => now)
    const first = await sealer.seal({ n: 1 }, 'a')
    const second = await sealer.seal({ n: 2 }, 'a')
    assert.equal(first.wk, second.wk)
    assert.notEqual(first.iv, second.iv)
    now = 1500
    const third = await sealer.seal({ n: 3 }, 'a')
    assert.notEqual(third.wk, first.wk)
    assert.equal(writer.calls.wrap, 2)

    const reader = countingWrapper(new LocalKeyWrapper(key))
    const opener = new Sealer(reader.wrapper)
    for (const sealed of [first, second, third]) await opener.open(sealed, 'a')
    assert.equal(reader.calls.unwrap, 2)
  })
})

describe('LocalKeyWrapper', () => {
  it('refuses keys of the wrong size and a foreign key id', async () => {
    assert.throws(() => new LocalKeyWrapper(randomBytes(16).toString('base64')))
    const wrapper = new LocalKeyWrapper(localKey())
    const { wrappedKey } = await wrapper.wrap(randomBytes(32))
    await assert.rejects(wrapper.unwrap('local:0000000000000000', wrappedKey))
  })
})

describe('Key Vault key ids', () => {
  const vault = normalizeVaultUrl('kv-example')
  const version = 'a'.repeat(32)

  it('normalizes names and https URLs and refuses other hosts', () => {
    assert.equal(vault, 'https://kv-example.vault.azure.net')
    assert.equal(normalizeVaultUrl('https://kv-example.vault.azure.net/'), vault)
    assert.throws(() => normalizeVaultUrl('https://evil.example.com'))
    assert.throws(() => normalizeVaultUrl('http://kv-example.vault.azure.net'))
  })

  it('accepts only versions of our own key', () => {
    assert.ok(isTrustedKid(vault, 'team-peers', `${vault}/keys/team-peers/${version}`))
    assert.ok(!isTrustedKid(vault, 'team-peers', `https://evil.example.com/keys/team-peers/${version}`))
    assert.ok(!isTrustedKid(vault, 'team-peers', `${vault}.evil.example.com/keys/team-peers/${version}`))
    assert.ok(!isTrustedKid(vault, 'team-peers', `${vault}/keys/other/${version}`))
    assert.ok(!isTrustedKid(vault, 'team-peers', `${vault}/keys/team-peers/${version}/../../x`))
    assert.ok(!isTrustedKid(vault, 'team-peers', `${vault}/keys/team-peers/${version}?api-version=1`))
  })
})

describe('wire format', () => {
  it('keeps only the recipient in clear text and round-trips the envelope', async () => {
    const sealer = new Sealer(new LocalKeyWrapper(localKey()))
    const message = newChat('alice', { text: 'secret plan', to: 'bob' })
    const wire = await toWire(sealer, message)
    assert.deepEqual(wire.applicationProperties, { recipient: 'bob' })
    assert.ok(!JSON.stringify(wire).includes('secret plan'))
    assert.ok(!JSON.stringify(wire.body).includes('alice'))
    assert.deepEqual(await fromWire(sealer, wire.body, wire.applicationProperties), {
      ...message,
      channel: undefined,
      replyTo: undefined,
    })
  })

  it('detects a swapped recipient property', async () => {
    const sealer = new Sealer(new LocalKeyWrapper(localKey()))
    const wire = await toWire(sealer, newChat('alice', { text: 'for bob', to: 'bob' }))
    await assert.rejects(fromWire(sealer, wire.body, { recipient: 'carol' }))
    await assert.rejects(fromWire(sealer, wire.body, {}))
  })

  it('drops a validly sealed envelope whose recipient differs from the property', async () => {
    const sealer = new Sealer(new LocalKeyWrapper(localKey()))
    const envelope = newChat('alice', { text: 'for bob', to: 'bob' })
    const sealed: Sealed = await sealer.seal(envelope, aadFor('carol'))
    assert.equal(await fromWire(sealer, { v: 2, sealed }, { recipient: 'carol' }), null)
  })

  it('ignores plain-text and unknown messages', async () => {
    const sealer = new Sealer(new LocalKeyWrapper(localKey()))
    const plain = { v: 1, kind: 'chat', id: 'm1', from: 'alice', ts: 1, text: 'hi', channel: 'general' }
    assert.equal(await fromWire(sealer, plain, {}), null)
    assert.equal(await fromWire(sealer, 'text', {}), null)
  })
})
