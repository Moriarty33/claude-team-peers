#!/usr/bin/env bash
# Prints the az commands by default; pass --apply to run them.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: setup-azure.sh --resource-group RG --namespace NS [options]

Creates a Standard Service Bus namespace with local (SAS key) auth disabled, one topic,
one filtered subscription per member and Entra ID role assignments:
  Azure Service Bus Data Sender on the topic, Azure Service Bus Data Receiver on the member's own subscription.

Options:
EOF
  printf '  %-27s %s\n' \
    '--location LOCATION' 'Region for a new namespace (required when it does not exist)' \
    '--topic NAME' 'Topic name (default: team-peers)' \
    '--message-ttl DURATION' 'ISO 8601 message lifetime (default: P1D)' \
    '--member HANDLE=UPN' 'Add a member, for example alice=alice@example.com (repeatable)' \
    '--remove-member HANDLE=UPN' "Delete the member's subscription and role assignments (repeatable)" \
    '--apply' 'Run the commands instead of printing them'
}

RG="" NS="" LOCATION="" TOPIC="team-peers" TTL="P1D" APPLY=0
MEMBERS=() REMOVALS=()
while [ $# -gt 0 ]; do
  case "$1" in
    "--resource-group") RG="$2"; shift 2 ;;
    "--namespace") NS="$2"; shift 2 ;;
    "--location") LOCATION="$2"; shift 2 ;;
    "--topic") TOPIC="$2"; shift 2 ;;
    "--message-ttl") TTL="$2"; shift 2 ;;
    "--member") MEMBERS+=("$2"); shift 2 ;;
    "--remove-member") REMOVALS+=("$2"); shift 2 ;;
    "--apply") APPLY=1; shift ;;
    "-h" | "--help") usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done
[ -n "$RG" ] && [ -n "$NS" ] || { usage >&2; exit 1; }

run() {
  if [ "$APPLY" = 1 ]; then echo "+ $*"; "$@"; else printf 'would run:'; printf ' %q' "$@"; echo; fi
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

SB=(az servicebus)
if ! "${SB[@]}" namespace show -g "$RG" -n "$NS" >/dev/null 2>&1; then
  [ -n "$LOCATION" ] || { echo "--location is required to create namespace $NS" >&2; exit 1; }
  run "${SB[@]}" namespace create -g "$RG" -n "$NS" -l "$LOCATION" --sku Standard --disable-local-auth true
fi
run "${SB[@]}" topic create -g "$RG" --namespace-name "$NS" -n "$TOPIC" --default-message-time-to-live "$TTL"

TOPIC_ID="$("${SB[@]}" topic show -g "$RG" --namespace-name "$NS" -n "$TOPIC" --query id -o tsv 2>/dev/null \
  || echo "<topic resource id>")"
SUB=("${SB[@]}" topic subscription)

for member in ${MEMBERS[@]+"${MEMBERS[@]}"}; do
  split_member "$member"
  OID="$(object_id "$UPN")"
  run "${SUB[@]}" create -g "$RG" --namespace-name "$NS" --topic-name "$TOPIC" -n "$HANDLE" \
    --default-message-time-to-live "$TTL" --lock-duration PT1M --max-delivery-count 5
  run "${SUB[@]}" rule create -g "$RG" --namespace-name "$NS" --topic-name "$TOPIC" --subscription-name "$HANDLE" \
    -n inbox --filter-sql-expression "recipient IS NULL OR recipient = '$HANDLE'"
  run "${SUB[@]}" rule delete -g "$RG" --namespace-name "$NS" --topic-name "$TOPIC" --subscription-name "$HANDLE" \
    -n "\$Default" || true
  run az role assignment create --assignee-object-id "$OID" --assignee-principal-type User \
    --role "Azure Service Bus Data Sender" --scope "$TOPIC_ID"
  run az role assignment create --assignee-object-id "$OID" --assignee-principal-type User \
    --role "Azure Service Bus Data Receiver" --scope "$TOPIC_ID/subscriptions/$HANDLE"
done

for member in ${REMOVALS[@]+"${REMOVALS[@]}"}; do
  split_member "$member"
  OID="$(object_id "$UPN")"
  run az role assignment delete --assignee "$OID" --role "Azure Service Bus Data Sender" --scope "$TOPIC_ID"
  run az role assignment delete --assignee "$OID" --role "Azure Service Bus Data Receiver" \
    --scope "$TOPIC_ID/subscriptions/$HANDLE"
  run "${SUB[@]}" delete -g "$RG" --namespace-name "$NS" --topic-name "$TOPIC" -n "$HANDLE"
done

[ "$APPLY" = 1 ] || echo "Dry run only. Re-run with --apply to make these changes."
