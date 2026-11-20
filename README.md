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
  `recipient IS NULL OR recipient = '<handle>'`, so direct messages to others are not delivered to them.
  Exactly one Claude Code tab per person listens; other sessions can still send and read history.
- **Entra ID only.** The namespace has local (SAS key) authentication disabled. Each person signs in with
  `az login`; access is a set of role assignments and revoking it is deleting them.
- **Self-registration.** With team-wide roles granted to an Entra group, `az login` is all a developer
  needs. The handle comes from the sign-in name (`alice.smith@example.com` becomes `alice-smith`), and the
  first listener start creates the person's subscription, tagged with their Entra object id so nobody else
  can take the same handle.

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
  --namespace <namespace> --key-vault <key-vault> --group "<Entra group of the team>"
```

The script prints the `az` commands; add `--apply` to run them, and it is safe to run again. It prints one
team `.env` to hand over through a channel you trust.

`--group` grants the group Sender and Receiver on the whole topic and Crypto User on the key, so members
register themselves. Developers also need permission to create subscriptions in the namespace (Contributor
on it). The trade-off: anyone in the group can join, and could attach to another member's subscription, so
direct messages are private by convention only. For private direct messages use `--member alice=alice@example.com`
instead: each member then gets Receiver on their own subscription only, and an admin adds every person.
`--remove-member` deletes a member's subscription and roles.

## Set up each developer

1. Add the marketplace and install the plugin inside Claude Code:

   ```text
   /plugin marketplace add Moriarty33/claude-team-peers
   /plugin install team-peers@claude-team-peers
   ```

2. Save the team `.env` the admin sent you as `~/.claude/team-peers/.env` and run
   `chmod 600 ~/.claude/team-peers/.env`:

   ```bash
   TEAM_PEERS_NAMESPACE=<namespace>
   TEAM_PEERS_KEY_VAULT_URL=https://<key-vault>.vault.azure.net
   TEAM_PEERS_AZURE_SUBSCRIPTION_ID=<subscription id>
   TEAM_PEERS_RESOURCE_GROUP=<rg>
   ```

   Add `TEAM_PEERS_HANDLE=<handle>` only if you want a handle other than the one from your sign-in name.

3. Run `az login`. On the first start of the listener tab your agent reports "Registered as @<handle>".

4. Add the `peers` command to `~/.zshrc` or `~/.bashrc`, then run `peers` in its own terminal tab and
   confirm the development-channel screen (see below why it is there):

   ```bash
   alias peers='TEAM_PEERS_LISTEN=1 claude --dangerously-load-development-channels plugin:team-peers@claude-team-peers'
   ```

### About `--dangerously-load-development-channels`

While Channels are a research preview, `--channels` accepts only plugins on Anthropic's allowlist, or on
Team and Enterprise plans an allowlist the organization sets. A plugin from its own marketplace, like this
one, can only be loaded with the development flag. What the flag does:

- It lets only the channels named after it register, here `plugin:team-peers@claude-team-peers`.
- It shows a confirmation screen on every start.
- It does not change the permission mode, skip any approval, or touch other plugins and MCP servers.

"Dangerously" means Anthropic has not reviewed this plugin. The code is public and small enough to read
before you install it.

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

Settings come from `~/.claude/team-peers/.env`; the same variables in the process environment win over it.
`TEAM_PEERS_LISTEN` and `TEAM_PEERS_STATE_DIR` are read from the process environment only.

| Variable | Default | Meaning |
|---|---|---|
| `TEAM_PEERS_HANDLE` | from `az login` | Your handle and subscription name; required for the emulator |
| `TEAM_PEERS_AZURE_SUBSCRIPTION_ID` | | With `TEAM_PEERS_RESOURCE_GROUP`, lets the listener create its own subscription |
| `TEAM_PEERS_RESOURCE_GROUP` | | Resource group of the namespace |
| `TEAM_PEERS_NAMESPACE` | required | Namespace name or full host name |
| `TEAM_PEERS_KEY_VAULT_URL` | required | Key Vault holding the team key |
| `TEAM_PEERS_KEY_NAME` | `team-peers` | Name of the Key Vault key |
| `TEAM_PEERS_TOPIC` | `team-peers` | Topic name |
| `TEAM_PEERS_MESSAGE_TTL_HOURS` | `24` | How long a message waits for an offline listener |
| `TEAM_PEERS_LISTEN` | unset | `1` makes this session the listener |
| `TEAM_PEERS_STATE_DIR` | `~/.claude/team-peers` | Where `.env`, channels, history and presence live |
| `TEAM_PEERS_CONNECTION_STRING` | | Local emulator only |
| `TEAM_PEERS_LOCAL_KEY` | | Emulator only: 32 random bytes, base64, instead of Key Vault |

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
