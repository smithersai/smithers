# 0132: Model connections, exactly as Amp's

Date: 2026-10-31. Status: accepted. Ruling [AUTH-10](../rulings.md#16-auth-roles-and-spend): Will, 2026-10-31 about
14:05: "we should be able to add claude subscription, codex subscription, jev and kimi k3 through moonshot please. ...
my ruling is we should do exactly what amp does". Amends [0096](0096-personal-models.md) (one model per person, plan
logins not built) and [0033](0033-coding-model-role.md) (no vendor in the product, no agent CLI as the coding agent).
Replaces PROC-23's 2026-10-21 addendum. Will reviews it with the feature (HOST-3).

## Decision

1. **An ordered list of connections.** A person's model becomes Amp's Model Routing: an ordered list of up to 16
   connections, each one credential plus its settings, each active or not. Kinds: `api_key` (any OpenAI- or
   Anthropic-compatible URL, today's model), `moonshot`, `claude_subscription`, `codex_subscription`, `jev`. The first
   active connection that names a model for a tier serves it (`resolveTier`). Check Access tests one connection.
   0096's sealing, origin pinning, ledger, failure display and no-fallback rule hold for every kind.
2. **Who writes a `todo` run.** Going down the person's active connections, the first subscription, or the first
   connection that serves `implement` itself, decides (`codingChoice`). A subscription means the vendor's own agent in
   the branch's box; anything else means the Smithers agent. Chat is never served by a subscription: only the vendor's
   agent may use a plan, as with Amp, whose own modes the Claude plan doesn't cover.
3. **Kimi K3 through Moonshot.** A `moonshot` connection is an `openai-chat` connection with
   `https://api.moonshot.ai` and `kimi-k3` filled in. `MOONSHOT_BASE_URL` and `MOONSHOT_MODEL` override them.
4. **Jev.** A person's own Jev is the key Jev is served with: a Vercel AI Gateway key for TypeSafe's model. The
   person's `judge` judgments go through `POST /api/me/model/jev` on that key. A person with no Jev connection keeps
   the `fast` tier's model, as before.
5. **Claude subscription.** The person runs `claude setup-token` themselves and pastes the token into Settings, as in
   Amp. We implement no claude.ai login.
6. **Codex subscription.** Amp's legacy flow, OpenAI's device code, run from our server: `POST /api/me/model/codex`
   asks for a code, the person types it at OpenAI, `model/CodexLink` polls and seals the tokens. Refresh tokens rotate,
   so a refresh holds the person's row and seals OpenAI's answer before anything else.
7. **The credential never enters the box.** The box holds a placeholder minted for its guest
   (`SandboxEgress.subscriptionPlaceholder`). Its egress replaces the placeholder with the value, opened per request
   from the sealed row, only toward the vendor's hosts: `api.anthropic.com` or `chatgpt.com`. This is ARCH-16's design
   with one added name. No log, trace, metric or card carries the credential (OBS-5).
8. **The exception to "every model call is a durable step".** AUTH-10 makes one: a vendor agent's own loop and its
   model calls happen inside it, where no journal reaches. The durable unit is one `sandbox/Command` job in
   `todo/ImplementCli`, chosen once by `todo/Route`, started once per attempt and collected once. Its calls are not in
   `personal_model_usage`, since the plan pays for them; `todo.agent_cli` records the run.

## What Amp does

Read from Amp's own code on 2026-10-31: `@ampcode/cli-darwin-arm64` 0.0.1793476832-ga2d2ae and the ampcode.com
Settings bundles. Byte offsets, since both are minified or compiled.

| Link | What it does | Where |
|---|---|---|
| Claude | Settings shows `claude setup-token` and takes the pasted token, prefix `sk-ant-oat`. The CLI has no Claude subscription command. | `5f81e9c75817eef9.js` byte 6047; `7687badadce72a6d.js` byte 3282 |
| ChatGPT | The CLI opens `/settings/model-routing?add=chatgpt` in the browser. | `amp` byte 114676980 |
| ChatGPT legacy | `add-chatgpt-subscription --legacy`; Settings fetches `/api/openai-chatgpt/oauth/start`, Amp's server runs the device code. | `amp` byte 114677259; `5f81e9c75817eef9.js` byte 11154 |

## Terms

Anthropic forbids third parties from implementing claude.ai login without approval, and blocks subscription tokens
outside Claude Code or the Agent SDK. We run unmodified Claude Code with the person's own token, so the box's only use
of it is Claude Code's. OpenAI's Sign in with ChatGPT for hosted apps needs partner approval
(developers.openai.com/siwc), so we use the device code, under the Codex CLI's public OAuth client.

**Follow-up:** apply to OpenAI's Sign in with ChatGPT partner program, then replace `CODEX_OAUTH_CLIENT_ID` and the
device flow. A person's ChatGPT plan may also forbid token sharing (Business and Enterprise workspaces can), which the
device code answers as a refusal.

## Choices the ruling didn't settle

- One active connection of each of `claude_subscription`, `codex_subscription` and `jev`, as Amp keeps one subscription
  of a kind.
- Codex's WebSocket transport is off (`supports_websockets=false`): the box's egress carries HTTP only, and Codex's
  default retries a socket for minutes first.
- The box's `auth.json` holds an unsigned id token with OpenAI's public claims, and a dummy refresh token. Codex checks
  no signature, sends it nowhere and, with a fresh `last_refresh`, never refreshes. Our Worker refreshes instead.
- Vendor agents run unsupervised (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`), as
  Amp's orbs do: the box is the fence.
- Claude Code and Codex are pinned by exact version in `infra/sandbox/Dockerfile` and never update themselves.

## Rejected

- **A claude.ai OAuth page of ours:** forbidden without Anthropic's approval, and not what Amp does.
- **The credential in the box's environment:** a repository's own code runs there. A placeholder keeps ARCH-16 whole.
- **Reviving `ExternalAgent` from 0033's rejected design:** a runner protocol and MCP tools. One `sandbox/Command` job
  does the same with the machinery the Smithers agent already uses.
- **A subscription serving chat:** a plan token outside the vendor's agent breaks both vendors' terms.

## Rollout

`0075_model_connections` and the code that reads it deploy as one step: the old code's `ON CONFLICT (person_id, protocol)`
has no matching constraint after it, and the new code can't read the old table. Migrations here are forward-only.
While there are no outside users that window is acceptable. To go back, a person's rows must first reduce to one
`api_key` row per protocol; then restore `PRIMARY KEY (person_id, protocol)`, restore both `NOT NULL`s, and drop `id`,
`kind`, `position`, `active`, `connection_id`, the two checks and `personal_models_one_subscription`.

## Known limits

- `todo/Route` chooses once; the box reads the list on each wake. A person who changes their list between the two fails
  that run at its first model call.
- A run's failure reason (`no_credential`, `timeout`) reaches `todo.agent_cli`, not the TODO's card, which says
  `implement`.

## Library catalog

`@smthrs/flow` (`todo/Route`, `todo/ImplementCli`, `model/CodexLink`), `@smthrs/secrets` `Egress` for the substitution,
`@smthrs/model` `Classifier` and `Evaluator` for Jev, `@smthrs/control` `WebCryptoCipher` for sealing,
`@smthrs/effect-electric` for the shape, `@smthrs/ui` for Settings. New in the image, not the app: `@anthropic-ai/claude-code`
and `@openai/codex`.
