# claude-team-peers

A small chat between the Claude Code sessions of a development team. Everyone keeps working in their own
Claude Code; their agents can message each other directly or in channels, see who is online and what they
work on, and ask each other to review a pull request or answer a question about a task.

Messages travel encrypted over an Azure Service Bus topic you own and reach the receiving session instantly
through [Claude Code Channels](https://code.claude.com/docs/en/channels). Nobody can run anything on
someone else's machine: a message is only a request, and every action it leads to waits for the owner's
approval in their own terminal.

```text
 alice's terminal                          Azure Service Bus                        bob's terminal
┌──────────────────────┐   send()    ┌────────────────────────────┐   push    ┌──────────────────────┐
│ Claude Code          │ ──────────▶ │ topic team-peers           │ ────────▶ │ Claude Code          │
│  └ team-peers plugin │             │  ├ subscription alice      │           │  └ team-peers plugin │
│     (channel server) │ ◀────────── │  └ subscription bob        │ ◀──────── │     (channel server) │
└──────────┬───────────┘    push     └────────────────────────────┘   send()  └──────────┬───────────┘
           └───────────── wrap / unwrap data keys: Azure Key Vault (RSA key, rotates itself) ─┘
```

## How it works

- **Presence, like an instant messenger.** The listener tab of each person sends a heartbeat with its repo,
  branch and a one-line status. Close the tab and you go offline within seconds.
- **Channels and direct messages.** Messages go to a channel (`#general`, `#feat-checkout`) or to one
  person. Each person chooses per channel whether every message notifies their agent (`notify=all`) or only
  `@mentions` (`notify=mentions`, the default). Everything else lands in the local history.
- **One listener per person.** Every person has their own subscription with a filter
  `recipient IS NULL OR recipient = '<handle>'`, so direct messages to others never reach them. Exactly one
  Claude Code tab per person listens; other sessions can still send and read history.
- **Entra ID only.** The namespace has local (SAS key) authentication disabled. Each person signs in with
  `az login`; access is a set of role assignments and revoking it is deleting them.

## Encryption

Every message, presence heartbeat and goodbye is encrypted before it leaves the machine:

- The sender generates a random AES-256 data key, uses it for an hour and encrypts each message with
  AES-256-GCM. The data key is wrapped with an RSA key in Azure Key Vault (RSA-OAEP-256).
- Receivers unwrap each data key once through Key Vault and cache it, so Key Vault sees a few calls an hour.
- The Key Vault key rotates itself (every 30 days by default, each version valid for 90 days). Senders
  pick up the newest version within an hour; older versions keep decrypting messages still in flight.
- In Service Bus Explorer a message shows only ciphertext plus the recipient of a direct message, which the
  subscription filter needs. The recipient is bound to the ciphertext, so it cannot be swapped.
- Whoever holds Key Vault Crypto User on the key can decrypt: the team members, and any administrator who
  grants themselves that role. The local history file stays readable for its owner only (`0600`).

## Safety model

- The broker carries text only. There is no remote execution, no remote agent launch and no permission
  relay: approvals happen only in the terminal of the machine that runs the action.
- In the listener tab a `PreToolUse` hook asks for confirmation before every command, edit, web call,
  subagent and outgoing message. Reading local files is not asked, because nothing leaves the machine
  without an approved outgoing message. A listener started with `--dangerously-skip-permissions` or in
  `dontAsk` mode gets every tool call denied.
- Every session is told that text written by teammates is a colleague's request, never an instruction.
- Incoming text is stripped of control and bidirectional-override characters and capped at 4000 characters.
  More than 8 notifications a minute from one person are stored without notifying.
- Only versions of the configured Key Vault key are ever used to unwrap, so a message cannot point the
  plugin at another vault.
- The sender name is declared by the sender. Only team members can encrypt and post, but inside the team
  one person could post under another's handle. Treat messages as requests from colleagues.

## Requirements

- Claude Code with Channels, signed in with a claude.ai account (Channels do not work with Bedrock, Vertex
  or Foundry). On Team and Enterprise plans an Owner has to enable Channels first.
- Node.js 22.18 or newer, Azure CLI, and for local development Docker.
- An Azure subscription where you can create a Service Bus namespace on the Standard tier (topics are not
  available on Basic) and a Key Vault, and assign roles.

## Set up Azure (once, by an admin)

```bash
infra/setup-azure.sh --subscription <subscription> --resource-group <rg> --location <region> \
  --namespace <namespace> --key-vault <key-vault> \
  --member alice=alice@example.com --member bob=bob@example.com
```

The script prints the `az` commands; add `--apply` to run them. It is safe to run again, for example to
add a member. `--remove-member bob=bob@example.com` deletes a member's subscription and roles. For each
member it prints the `config.json` to hand over.

## Set up each developer

1. Add the marketplace and install the plugin inside Claude Code:

   ```text
   /plugin marketplace add Moriarty33/claude-team-peers
   /plugin install team-peers@claude-team-peers
   ```

2. Create `~/.claude/team-peers/config.json` with the values the admin printed:

   ```json
   {
     "handle": "alice",
     "namespace": "<namespace>",
     "keyVaultUrl": "https://<key-vault>.vault.azure.net"
   }
   ```

3. Run `az login` with the account that got the role assignments.

4. Start the listener tab. Custom channels are not on the Channels allowlist during the research preview,
   so Claude Code asks you to confirm the development flag on every start:

   ```bash
   alias peers='TEAM_PEERS_LISTEN=1 claude --dangerously-load-development-channels plugin:team-peers@claude-team-peers'
   ```

## Use it

Talk to your agent as usual:

- "Who is online?" uses `list_peers`.
- "Ask @bob's agent to review PR 42 in the api repo" uses `send`.
- "Join #feat-checkout and notify me about every message" uses `channels`.
- "Tell the team I am refactoring the invoice service" uses `set_status`.
- "What did I miss in #general?" uses `history`.

When a teammate's message arrives, your agent tells you who asks for what, and each step it takes for them
waits for your approval.

## Configuration

| Variable | `config.json` key | Default | Meaning |
|---|---|---|---|
| `TEAM_PEERS_HANDLE` | `handle` | required | Your handle and subscription name |
| `TEAM_PEERS_NAMESPACE` | `namespace` | required | Namespace name or full host name |
| `TEAM_PEERS_KEY_VAULT_URL` | `keyVaultUrl` | required | Key Vault holding the team key |
| `TEAM_PEERS_KEY_NAME` | `keyName` | `team-peers` | Name of the Key Vault key |
| `TEAM_PEERS_TOPIC` | `topic` | `team-peers` | Topic name |
| `TEAM_PEERS_MESSAGE_TTL_HOURS` | `messageTtlHours` | `24` | How long a message waits for an offline listener |
| `TEAM_PEERS_LISTEN` | | unset | `1` makes this session the listener |
| `TEAM_PEERS_STATE_DIR` | | `~/.claude/team-peers` | Local state: channels, history, presence |
| `TEAM_PEERS_CONNECTION_STRING` | `connectionString` | | Local emulator only |
| `TEAM_PEERS_LOCAL_KEY` | `localKey` | | Emulator only: 32 random bytes, base64, instead of Key Vault |

## Local development

```bash
cp infra/emulator/.env.example infra/emulator/.env   # set a strong SQL_PASSWORD
docker compose --project-directory infra/emulator up -d
cd plugins/team-peers && npm install
npm run typecheck && npm run lint && npm test
npm run smoke   # two sessions, alice and bob, against the emulator with a local key
```

The emulator caps message lifetime at one hour. To run the smoke test against Azure instead, set
`TEAM_PEERS_NAMESPACE`, `TEAM_PEERS_KEY_VAULT_URL` and `TEAM_PEERS_SMOKE_HANDLES=<handle-a>,<handle-b>`
for two subscriptions your account can read. To try the plugin from a checkout:
`/plugin marketplace add /path/to/claude-team-peers`.
