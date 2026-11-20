import { ServiceBusManagementClient } from '@azure/arm-servicebus'
import type { TokenCredential } from '@azure/identity'

export type SubscriptionInfo = {
  userMetadata?: string
  lockDuration?: string
  maxDeliveryCount?: number
  defaultMessageTimeToLive?: string
}

export type SubscriptionAdmin = {
  getSubscription(name: string): Promise<SubscriptionInfo | undefined>
  putSubscription(name: string, info: SubscriptionInfo): Promise<void>
  hasRule(subscription: string, rule: string): Promise<boolean>
  putSqlRule(subscription: string, rule: string, sqlExpression: string): Promise<void>
  deleteRule(subscription: string, rule: string): Promise<void>
}

export type Registration = 'created' | 'claimed' | 'existing'

const RULE = 'inbox'
const OWNER_PREFIX = 'team-peers-owner:'

export const ownerTag = (objectId: string) => `${OWNER_PREFIX}${objectId}`
export const inboxFilter = (handle: string) => `recipient IS NULL OR recipient = '${handle}'`

/** Creates the caller's subscription, or adopts an unowned one; refuses a handle owned by someone else. */
export async function ensureSubscription(
  admin: SubscriptionAdmin,
  handle: string,
  objectId: string,
  messageTtl: string,
): Promise<Registration> {
  const owner = ownerTag(objectId)
  const existing = await admin.getSubscription(handle)
  let outcome: Registration = 'existing'
  if (existing?.userMetadata && existing.userMetadata !== owner) {
    throw new Error(`@${handle} belongs to another account; set TEAM_PEERS_HANDLE to a different handle`)
  }
  if (!existing) {
    await admin.putSubscription(handle, {
      userMetadata: owner,
      lockDuration: 'PT1M',
      maxDeliveryCount: 5,
      defaultMessageTimeToLive: messageTtl,
    })
    outcome = 'created'
  } else if (!existing.userMetadata) {
    await admin.putSubscription(handle, { ...existing, userMetadata: owner })
    outcome = 'claimed'
  }
  if (!(await admin.hasRule(handle, RULE))) await admin.putSqlRule(handle, RULE, inboxFilter(handle))
  await admin.deleteRule(handle, '$Default')
  return outcome
}

type Target = { subscriptionId: string; resourceGroup: string; namespace: string; topic: string }

const isNotFound = (error: unknown) => (error as { statusCode?: number })?.statusCode === 404

export function armSubscriptionAdmin(credential: TokenCredential, target: Target): SubscriptionAdmin {
  const client = new ServiceBusManagementClient(credential, target.subscriptionId)
  const scope = [target.resourceGroup, target.namespace, target.topic] as const
  return {
    async getSubscription(name) {
      try {
        const found = await client.subscriptions.get(...scope, name)
        return {
          userMetadata: found.userMetadata,
          lockDuration: found.lockDuration,
          maxDeliveryCount: found.maxDeliveryCount,
          defaultMessageTimeToLive: found.defaultMessageTimeToLive,
        }
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw error
      }
    },
    async putSubscription(name, info) {
      await client.subscriptions.createOrUpdate(...scope, name, info)
    },
    async hasRule(subscription, rule) {
      try {
        await client.rules.get(...scope, subscription, rule)
        return true
      } catch (error) {
        if (isNotFound(error)) return false
        throw error
      }
    },
    async putSqlRule(subscription, rule, sqlExpression) {
      await client.rules.createOrUpdate(...scope, subscription, rule, {
        filterType: 'SqlFilter',
        sqlFilter: { sqlExpression },
      })
    },
    async deleteRule(subscription, rule) {
      try {
        await client.rules.delete(...scope, subscription, rule)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    },
  }
}
