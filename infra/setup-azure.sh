#!/usr/bin/env bash
# Prints the az commands by default; pass --apply to run them.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: setup-azure.sh --resource-group RG --namespace NS --key-vault KV [options]

Creates a Standard Service Bus namespace with local (SAS key) auth disabled, one topic, a Key Vault
(RBAC mode) with an RSA key that rotates itself, and per member: a filtered subscription plus the roles
Azure Service Bus Data Sender (topic), Azure Service Bus Data Receiver (own subscription) and
Key Vault Crypto User (the key only). Give each person exactly one handle: removing a handle removes
that person's topic and key roles too.

Options:
EOF
  printf '  %-27s %s\n' \
    '--subscription NAME_OR_ID' 'Azure subscription to use; your az default is restored afterwards' \
    '--location LOCATION' 'Region for new resources (required when they do not exist)' \
    '--topic NAME' 'Topic name (default: team-peers)' \
    '--key-name NAME' 'Key Vault key name (default: team-peers)' \
    '--rotate-after DURATION' 'ISO 8601 age that triggers key rotation (default: P30D)' \
    '--key-expiry DURATION' 'ISO 8601 lifetime of each key version (default: P90D)' \
    '--message-ttl DURATION' 'ISO 8601 message lifetime (default: P1D)' \
    '--group NAME' 'Let an Entra group join with az login alone: roles on the whole topic and key (repeatable)' \
    '--member HANDLE=UPN' 'Add a member, for example alice=alice@example.com (repeatable)' \
    '--remove-member HANDLE=UPN' "Delete the member's subscription and role assignments (repeatable)" \
    '--apply' 'Run the commands instead of printing them'
}

RG="" NS="" KV="" SUBSCRIPTION="" LOCATION="" TOPIC="team-peers" KEY="team-peers"
ROTATE="P30D" EXPIRY="P90D" TTL="P1D" APPLY=0
MEMBERS=() REMOVALS=() TEAM_GROUPS=()
while [ $# -gt 0 ]; do
  case "$1" in
    "--resource-group") RG="$2"; shift 2 ;;
    "--namespace") NS="$2"; shift 2 ;;
    "--key-vault") KV="$2"; shift 2 ;;
    "--subscription") SUBSCRIPTION="$2"; shift 2 ;;
    "--location") LOCATION="$2"; shift 2 ;;
    "--topic") TOPIC="$2"; shift 2 ;;
    "--key-name") KEY="$2"; shift 2 ;;
    "--rotate-after") ROTATE="$2"; shift 2 ;;
    "--key-expiry") EXPIRY="$2"; shift 2 ;;
    "--message-ttl") TTL="$2"; shift 2 ;;
    "--group") TEAM_GROUPS+=("$2"); shift 2 ;;
    "--member") MEMBERS+=("$2"); shift 2 ;;
    "--remove-member") REMOVALS+=("$2"); shift 2 ;;
    "--apply") APPLY=1; shift ;;
    "-h" | "--help") usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done
[ -n "$RG" ] && [ -n "$NS" ] && [ -n "$KV" ] || { usage >&2; exit 1; }

if [ -n "$SUBSCRIPTION" ]; then
  PREVIOUS_SUBSCRIPTION="$(az account show --query id -o tsv)"
  trap 'az account set --subscription "$PREVIOUS_SUBSCRIPTION"' EXIT
  az account set --subscription "$SUBSCRIPTION"
fi

run() {
  if [ "$APPLY" = 1 ]; then echo "+ $*"; "$@"; else printf 'would run:'; printf ' %q' "$@"; echo; fi
}

# New role assignments take a few minutes to reach Key Vault's data plane.
run_until_authorized() {
  if [ "$APPLY" != 1 ]; then run "$@"; return; fi
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    echo "+ $* (attempt $attempt)"
    if "$@"; then return 0; fi
    sleep 15
  done
  return 1
}

split_member() {
  HANDLE="${1%%=*}"
  UPN="${1#*=}"
  if ! [[ "$HANDLE" =~ ^[a-z0-9][a-z0-9-]{1,31}$ ]] || [ "$UPN" = "$1" ] || [ -z "$UPN" ]; then
    echo "Member must look like handle=user@domain with a lowercase handle, got: $1" >&2
    exit 1
  fi
}

object_id() {
  az ad user show --id "$1" --query id -o tsv 2>/dev/null || echo "<object id of $1>"
}

require_location() {
  [ -n "$LOCATION" ] || { echo "--location is required to create $1" >&2; exit 1; }
}

SB=(az servicebus)
SUB=("${SB[@]}" topic subscription)
NS_ARGS=(-g "$RG" --namespace-name "$NS")

if ! "${SB[@]}" namespace show -g "$RG" -n "$NS" >/dev/null 2>&1; then
  require_location "namespace $NS"
  run "${SB[@]}" namespace create -g "$RG" -n "$NS" -l "$LOCATION" --sku Standard --disable-local-auth true
fi
run "${SB[@]}" topic create "${NS_ARGS[@]}" -n "$TOPIC" --default-message-time-to-live "$TTL"
TOPIC_ID="$("${SB[@]}" topic show "${NS_ARGS[@]}" -n "$TOPIC" --query id -o tsv 2>/dev/null || echo "<topic id>")"

if ! az keyvault show -g "$RG" -n "$KV" >/dev/null 2>&1; then
  require_location "key vault $KV"
  run az keyvault create -g "$RG" -n "$KV" -l "$LOCATION" --enable-rbac-authorization true --retention-days 7
fi
KV_ID="$(az keyvault show -g "$RG" -n "$KV" --query id -o tsv 2>/dev/null || echo "<key vault id>")"
ADMIN_ID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "<your object id>")"
run az role assignment create --assignee-object-id "$ADMIN_ID" --assignee-principal-type User \
  --role "Key Vault Crypto Officer" --scope "$KV_ID"

if ! az keyvault key show --vault-name "$KV" -n "$KEY" >/dev/null 2>&1; then
  run_until_authorized az keyvault key create --vault-name "$KV" -n "$KEY" --kty RSA --size 2048 \
    --ops wrapKey unwrapKey
fi
POLICY="{\"lifetimeActions\":[{\"trigger\":{\"timeAfterCreate\":\"$ROTATE\"},\"action\":{\"type\":\"Rotate\"}}],\"attributes\":{\"expiryTime\":\"$EXPIRY\"}}"
run_until_authorized az keyvault key rotation-policy update --vault-name "$KV" -n "$KEY" --value "$POLICY"

# A group-wide Receiver role on the topic lets members read each other's subscriptions: privacy by convention.
for group in ${TEAM_GROUPS[@]+"${TEAM_GROUPS[@]}"}; do
  GID="$(az ad group show --group "$group" --query id -o tsv 2>/dev/null || echo "<object id of $group>")"
  for role in "Azure Service Bus Data Sender" "Azure Service Bus Data Receiver"; do
    run az role assignment create --assignee-object-id "$GID" --assignee-principal-type Group \
      --role "$role" --scope "$TOPIC_ID"
  done
  run az role assignment create --assignee-object-id "$GID" --assignee-principal-type Group \
    --role "Key Vault Crypto User" --scope "$KV_ID/keys/$KEY"
done

for member in ${MEMBERS[@]+"${MEMBERS[@]}"}; do
  split_member "$member"
  OID="$(object_id "$UPN")"
  run "${SUB[@]}" create "${NS_ARGS[@]}" --topic-name "$TOPIC" -n "$HANDLE" \
    --default-message-time-to-live "$TTL" --lock-duration PT1M --max-delivery-count 5
  RULES=("${SUB[@]}" rule)
  RULE_ARGS=("${NS_ARGS[@]}" --topic-name "$TOPIC" --subscription-name "$HANDLE")
  if ! "${RULES[@]}" show "${RULE_ARGS[@]}" -n inbox >/dev/null 2>&1; then
    run "${RULES[@]}" create "${RULE_ARGS[@]}" -n inbox \
      --filter-sql-expression "recipient IS NULL OR recipient = '$HANDLE'"
  fi
  run "${RULES[@]}" delete "${RULE_ARGS[@]}" -n "\$Default" || true
  run az role assignment create --assignee-object-id "$OID" --assignee-principal-type User \
    --role "Azure Service Bus Data Sender" --scope "$TOPIC_ID"
  run az role assignment create --assignee-object-id "$OID" --assignee-principal-type User \
    --role "Azure Service Bus Data Receiver" --scope "$TOPIC_ID/subscriptions/$HANDLE"
  run az role assignment create --assignee-object-id "$OID" --assignee-principal-type User \
    --role "Key Vault Crypto User" --scope "$KV_ID/keys/$KEY"
  echo "--- ~/.claude/team-peers/.env for $HANDLE (chmod 600):"
  printf 'TEAM_PEERS_HANDLE=%s\nTEAM_PEERS_NAMESPACE=%s\nTEAM_PEERS_KEY_VAULT_URL=https://%s.vault.azure.net\n' \
    "$HANDLE" "$NS" "$KV"
done

for member in ${REMOVALS[@]+"${REMOVALS[@]}"}; do
  split_member "$member"
  OID="$(object_id "$UPN")"
  run az role assignment delete --assignee "$OID" --role "Azure Service Bus Data Sender" --scope "$TOPIC_ID"
  run az role assignment delete --assignee "$OID" --role "Azure Service Bus Data Receiver" \
    --scope "$TOPIC_ID/subscriptions/$HANDLE"
  run az role assignment delete --assignee "$OID" --role "Key Vault Crypto User" --scope "$KV_ID/keys/$KEY"
  run "${SUB[@]}" delete "${NS_ARGS[@]}" --topic-name "$TOPIC" -n "$HANDLE"
done

if [ ${#TEAM_GROUPS[@]} -gt 0 ]; then
  echo "--- team ~/.claude/team-peers/.env for self-registration (chmod 600; the handle comes from az login):"
  printf 'TEAM_PEERS_NAMESPACE=%s\nTEAM_PEERS_KEY_VAULT_URL=https://%s.vault.azure.net\n' "$NS" "$KV"
  printf 'TEAM_PEERS_AZURE_SUBSCRIPTION_ID=%s\nTEAM_PEERS_RESOURCE_GROUP=%s\n' \
    "$(az account show --query id -o tsv)" "$RG"
fi

[ "$APPLY" = 1 ] || echo "Dry run only. Re-run with --apply to make these changes."
