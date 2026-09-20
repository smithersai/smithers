# Models: manual test script

Every step names what to do and what you must see. Anything else is a bug.
The automated receipt is step 14. No paid key is needed before step 13.
Step 12b composes a request and asks it.

A credential is a NAME pinned to an origin. Enroll its value in the local
macOS app; it stays in the host keychain. Model records carry only the name.

## 0. Before you start

```sh
df -h /System/Volumes/Data      # Avail must read at least 2Gi
lsof -nP -iTCP:47400 -iTCP:47500 -sTCP:LISTEN   # must print nothing
cd ~/smithers/apps/app
pnpm build:web
```

See: `✓ built in …`. The build writes about 20 MB to `dist/`.

## 1. Terminal A: the loopback provider

```sh
cd ~/smithers/apps/app
SMITHERS_MODEL_PROVIDER_KEY=sk-loopback-will-0123456789abcdef \
SMITHERS_MODEL_PROVIDER_PORT=47500 \
SMITHERS_MODEL_PROVIDER_SLOW_MS=30000 \
bun e2e/real/support/model-provider.ts
```

See: `{"event":"ready","origin":"http://127.0.0.1:47500","port":47500}`

Check it refuses a request with no key:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:47500/v1/chat/completions \
  -H 'content-type: application/json' -d '{"model":"e2e-answers"}'
```

See: `401`

## 2. Terminal B: the app, without model environment keys

```sh
cd ~/smithers/apps/app
SMITHERS_LOCAL_PORT=47400 SMITHERS_LOCAL_MODE=hybrid \
SMITHERS_LOCAL_STATE_DIR=/tmp/smithers-models-manual \
bun src/bun/serve.ts
```

See: `SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:47400`. Open that address in
Chrome. No sign-in is needed. Use a fresh state directory for a fresh vault.

1. Cmd+K, `/model.list`, Enter. Click New and open Credential.
2. Choose Add credential. In its embedded form enter Name `LOOPBACK`, Origin
   `http://127.0.0.1:47500`, API key `sk-loopback-will-0123456789abcdef`.
3. Tab to Add and press Enter. See: the password clears immediately. Chat
   stays usable; a slow keychain operation keeps the shared toast running.
   The credential picker gains LOOPBACK only after host completion.
4. Open `/model.credential.new`. Enroll `REVOKED` on the same origin with
   `sk-revoked-will-0123456789abcdef`. The form accepts a value once; reload
   never restores it.
5. Restart Terminal B with the same state directory. Reload, `/model.list`.
   See both names. The keys were restored from macOS keychain, not the browser.

On the cloud host the disabled Add credential option reads Local host required.
Off macOS it reads Keychain unavailable. A locked keychain fails visibly and can
be retried after unlocking. Nothing claims successful in-memory-only enrollment.

## 3. Create

1. Press Cmd+K, type `/model.list`, press Enter.
   The command acknowledges `Requested` immediately. With a slow catalog, the
   shared `Loading models…` toast appears after 300 ms and stays until the
   catalog answers. A repeated `/model.list` joins the same refresh. Chat
   remains usable. A failed refresh shows its typed code; a visible toast
   settles as failed with Retry;
   `/model.list` retries it. Reload during the request: the refresh resumes.
   See: a `Models` card. It lists only the host's own rows (`cerebras`
   `generation`, when `CEREBRAS_API_KEY` is exported in Terminal B), or
   `No models.` A host row has a `Test` button and no `Edit` or `Remove`.
   Without `SMITHERS_LOCAL_MODE=hybrid` the host is offline and lists no host
   row at all: it could reach none of them.
2. Click `New`.
   See: a form with `Name`, `Protocol`, `Base URL`, `Path`, `Model`,
   `Credential`, `Cancel` and `Save`. This model form stores only credential names. `Save` stays
   disabled until Name, Protocol, Model and Credential are filled.
   `Credential` is a pick list: the five built-in names, then `LOOPBACK` and
   `REVOKED`, then Add credential. A built-in name whose key the host lacks reads
   `ANTHROPIC_API_KEY · missing` and cannot be picked.
3. Fill: Name `loopback-chat`, Protocol `openai-chat`, Base URL
   `http://127.0.0.1:47500`, Model `e2e-answers`, Credential `LOOPBACK`.
   Leave Path empty. Click `Save`.
   See: the Models card gains the row `loopback-chat` `generation`, first in
   the list, with `Test`, `Edit` and `Remove`. The card carries no sentence of
   explanation.

A name is lowercase letters, digits and dashes, starts with a letter, and is
at most 40 characters. Save the same form with Name `Loopback Chat`.
See: the form stays open and reads `invalid · name`.

The card in the transcript shows four rows, led by the model you last saved or
tested, then `+N` for the rest. `Maximize card` shows every row.

## 4. Test, green

Click `Test` on `loopback-chat`.

See at once: the row's dot shows running, `Test` is disabled, and chat still
works (press Cmd+K and type; the composer accepts it).
See within a second: the dot turns green and the row reads a latency such as
`31 ms`.

In a third terminal:

```sh
curl -s http://127.0.0.1:47500/__journal | tail -c 400
```

See: `"status":200`, `"authorized":true`, a `credentialSha256`, and no
`sk-loopback` anywhere.

## 5. The key never reaches the browser

1. Open DevTools, Network. Click `Test` again. Open the `test` request
   (`POST /api/model/test`).
   See: the payload holds `"credential":"LOOPBACK"`. Search the payload and the
   response for `sk-loopback`: no match. The response is
   `{"ok":true,"latencyMs":…,"sample":…}`.
2. DevTools, Elements: press Cmd+F, search `sk-loopback`: no match.
3. Open `GET /api/model/catalog` in Network.
   See: credential names, `present` flags and origins. No value.

## 6. It is listed after a reload

Press Cmd+R. Press Cmd+K, type `/model.list`, press Enter.
See: `loopback-chat` is there, with its last green result.

To check a pending Test, create `slow` from step 7c, press Test, and reload
while its dot is running. See: one resumed Test in Network, a running toast,
then `timeout · 15000 ms` and a settled failure toast. The pending request is
not silently discarded by the identity read during boot.

## 7. Failures. Each shows a typed code, and `Test` stays available

After a failed test the card's pill reads `FAILED` and the card shrinks to the
failed row and one button. The button is `Edit` when the record is wrong (a,
d, e, f, g below) and `Test` when it is not (b, c, h: a rate limit, a timeout,
a provider that is down). The failed toast carries the same button.
`/model.list` brings the list back.

| # | Create this model (other fields as in step 3) | Click `Test`. See on the row | Journal |
| --- | --- | --- | --- |
| a | Name `revoked`, Credential `REVOKED` | `refused · 401` | one new entry, `"status":401`, `"authorized":false` |
| b | Name `limited`, Model `e2e-rate-limited` | `refused · 429`, within a second | exactly one new entry, `429`. A Test never retries |
| c | Name `slow`, Model `e2e-slow` | running for 15 seconds, then `timeout · 15000 ms`. Chat stays usable while it runs | one new entry |
| d | Name `garbled`, Model `e2e-garbled` | `invalid · protocol` | one new entry, `200` |
| e | Name `elsewhere`, Base URL `http://127.0.0.1:47501` | `endpoint_forbidden`, instantly | no new entry. The host never dialed out |
| f | Name `remote`, Base URL `https://example.com` | `endpoint_forbidden`, instantly | no new entry. `LOOPBACK` is pinned to the origin you declared and nothing else |

g. A name nobody declared. Press Cmd+K and run:

```
/model.save --name undeclared --protocol openai-chat --model e2e-answers --credential HOME --url http://127.0.0.1:47500
```

Click `Test` on `undeclared`. See: `credential_unknown · HOME`, and no new
journal entry. `HOME` is set in the host's environment, and the host still
refuses to read it: only `SMITHERS_MODEL_KEY_<NAME>` with its `_ORIGIN` is a
credential.

h. Provider down. Press Ctrl+C in Terminal A. Run `/model.list`, click
`Maximize card`, click `Test` on `loopback-chat`. See: `unreachable`. Start
Terminal A's command again. Click `Test`. See: green.

i. Mend a failure. On `revoked`, click `Edit`. See: the pane returns to the
transcript and the form opens filled in. Set Credential
`LOOPBACK`, click `Save`, click `Test`. See: green.

## 8. Edit and remove

1. On `garbled`, click `Edit`. The form opens filled in. Change Model to
   `e2e-answers`. Click `Save`. Click `Test`. See: green. Reload, run
   `/model.list`: still one `garbled` row, still the new model id (step 10
   shows where the id is drawn).
2. Saving under a new Name creates a second model. The name is the id.
3. On `limited`, click `Remove`. See: the row is gone at once. Reload, run
   `/model.list`: still gone.

## 9. A decision model

Click `New`. Name `loopback-jev`, Protocol `evaluation`, Base URL
`http://127.0.0.1:47500`, Model `e2e-answers`, Credential `LOOPBACK`. `Save`.
See: the row `loopback-jev` `decision`.

Click `Test`. See: green with a latency. The journal's new entry reads
`"protocol":"evaluation"` and carries `"ai-model-id":"e2e-answers"`.

Click `Edit`, set Credential `REVOKED`, `Save`, `Test`. See: `refused · 401`,
and exactly one new journal entry, protocol `evaluation`. Nothing else was
asked in its place.

## 10. The card, maximized, and the seat

1. Run `/model.list`. Press Tab to `Maximize card`, press Enter.
   See: the card fills the pane, focus is on `Restore`. Left: every model.
   Right: the selected model's `Protocol`, `Model`, `URL`, `Credential`, and a
   table with the columns `Seat` and `Model`. The `undeclared` model's
   Credential reads `HOME · missing`.
2. Click the `garbled` row. See: its facts, with Model `e2e-answers` from
   step 8.
3. The local host lists one seat, `Explainer`. Open its list.
   See: `Default`, then `cerebras` and your generation models. `loopback-jev`
   is not offered: a decision model cannot take a generation seat.
4. Press Escape. See: the card is back in the transcript and focus is on
   `Maximize card`.

## 11. Assign a seat and see it answer

There are three seats. The local host serves `Explainer`. The cloud host
serves all three.

### Explainer (local host, no sign-in)

1. Seat unassigned. Press Cmd+K and run `/agent.explain the loopback provider`.
   See: an `Explain: the loopback provider` card. If the host has an agent, it
   answers in paragraphs and its last line reads
   `asked for the Explainer role (Kimi K3); the serving side chooses the model`.
   The provider journal gains no entry.
2. Run `/model.list`, `Maximize card`, and in the `Explainer` row pick
   `loopback-chat`. The same act by slash: `/model.assign explainer loopback-chat`.
3. Press Escape. Run `/agent.explain the loopback provider` again.
   See: the answer paints once when the provider finishes. It is exactly
   `loopback pong`, the provider's fixed reply, and
   the card's last line reads `loopback-chat`. The journal gains one entry,
   `"protocol":"openai-chat"`, `"status":200`, `"authorized":true`.
4. Reload. Run `/model.list`, maximize.
   See: `Explainer` still reads `loopback-chat`.
5. Click `Remove` on `loopback-chat`. See: the row is gone and `Explainer`
   reads `Default`. `/model.assign explainer default` hands a seat back
   without removing the model.
6. Run `/model.assign front-door loopback-jev`.
   See: `This host has no Front door seat.`

Repeat steps 2–3 with Terminal B restarted using `SMITHERS_LOCAL_MODE=offline`
and the same state directory. See: Test still passes and the assigned
Explainer still answers `loopback pong`. Select Default and ask again: the
explanation is unavailable. The offline host never reaches a cloud agent.

Set a model's Model to `e2e-echoes`, assign it to Explainer, and ask again.
See: `your key is` with no key in the answer, response frames, DOM or stored
state. The provider sends nested credential fragments across three deltas;
the host sanitizes the complete answer before publishing it.

### Front door and Recommendations (cloud host, signed in)

Not run for this script: both need the deployed Worker and a signed-in
account. The automated proof is `src/mainview/state/controller/models.test.ts`
and the Worker's route tests.

1. On the cloud app, sign in and run `/model.list`, `Maximize card`.
   See: three seat rows, `Explainer`, `Front door`, `Recommendations`, and a
   host row `typesafe-ai-jev` `decision`.
2. In `Front door` pick `typesafe-ai-jev`. Open DevTools, Network. Send any
   chat message. Open the turn request.
   See: the payload carries `"decisionModel":{"protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"}`.
   With `Default` the key is absent.
3. In `Recommendations` pick `typesafe-ai-jev`. Do anything that refreshes the
   next-step pills. Open `POST /api/recommend`.
   See: the payload carries the same object under `"model"`.
4. A decision model whose id is not `typesafe-ai/jev` on a built-in credential
   is refused: the request answers 400 `request_invalid`. It never falls back.

## 12. Rotate, remove, and use your own endpoint

1. `/model.list`, Maximize card. In Credentials, press Rotate for LOOPBACK.
   The embedded form has its name and a blank API key, with no editable origin.
   Enter the revoked fixture from step 2 and press Rotate. Test `loopback-chat`:
   see `refused · 401`, and the journal gains the revoked key's SHA-256 only.
2. Rotate LOOPBACK back to the provider's accepted key. Test: green.
3. Add credential with Name LOOPBACK and Origin `https://example.com`.
   Submit any fixture key. See `exists`; the original pin and value still work.
4. In the maximized Credentials section, Remove LOOPBACK. Its value is gone;
   Test on a model using it reads `credential_missing · LOOPBACK`, without
   contacting the provider. Reload: still removed. Its pin remains reserved;
   Rotate restores a value on that same origin. Add cannot repin the name.
5. For Ollama, Add credential: Name OLLAMA, Origin `http://127.0.0.1:11434`,
   API key `anything-nonblank`. New model: Name `ollama-qwen`, Protocol
   `openai-chat`, Base URL `http://127.0.0.1:11434`, Model one you have loaded,
   Credential OLLAMA. Save, Test. No host environment edit or restart is needed.

`http:` is allowed only for loopback. Other origins must use `https:`. Built-in
credential names retain their predefined provider pins. Environment-declared
keys remain read-only; rotate or remove those in the host environment. A custom
Path belongs only to `openai-chat`.

For agent parity, ask the agent to enroll a credential with a name and origin.
See a confirmation before any key is collected. Confirm opens the human's key
form. Never put an API key in chat or a slash command.

Reload while a submission is pending: a completed host receipt resolves it.
If no receipt exists, see `interrupted`; Retry asks for the key again. It never
replays a persisted key, and a duplicate press never rotates or repins anything.

## 12b. Compose a request and ask

The request is yours to edit; the answer is the model's. Nothing on the card
edits an answer.

1. On `loopback-jev` (step 9, tested green), click `Compose`.
   See: a `loopback-jev` card with one state field `text` = `The sky is blue.`,
   one question `ok` of kind `boolean`, its answer `yes · 0.97`, and a green
   latency: the Test you ran, prefilled. Buttons: `Ask again`, `Last test`,
   `Fixture`.
2. Click `Add question`. See: `q1`, kind `boolean`, an empty question, the
   line `question_empty · q1` and `Ask again` disabled. The answers above are
   struck: the request no longer matches what they answered.
3. Set `q1`'s kind to `choice`. See: `options_count · q1 · 0`. Click
   `Add option` twice, type `Which is it?` as the question, type `the sky`
   beside `option1`. Set another question to `score` and add two rungs. See:
   the line is gone and `Ask again` is enabled. Type `pick` over `q1` and
   leave the box. See: the block reads `pick` with its kind, wording and
   options kept.
4. Click `Add field`, set its kind to `boolean`, tick it.
5. Click `Ask again`. See at once: the card's pill reads running and chat still
   works. See within a second: per question, `ok` `yes · 0.97`, `pick`
   `option1 · 0.97`, `q2` `rung2 · 1`, and a latency. The journal's new entry
   carries `"questions":["ok","pick","q2"]` and the state as one JSON object
   with `"field1":true`.
6. Edit any question. See: every answer struck and dimmed, nothing removed.
   Click `Last test`. See: the fixed request and the Test's answer are back.
7. Click `Fixture`. See: an `Evaluator.layerScripted(() => ({ ... }))` block
   with one line per question, and `Copy`.
8. On `loopback-chat`, click `Compose`. See: `System`, `Prompt` =
   `Reply with the single word: ok`, `Max tokens` 32, `Temperature` empty,
   and no `Last test`: it was never tested. Type a system prompt and `ping?`,
   click `Ask`. See: `loopback pong` and a latency; the journal's entry reads
   `"system":true`. Change the prompt. See: the words struck until you ask
   again. Paste more than 16 KiB into `Prompt`. See: the box stops at 16 KiB
   and the card keeps what it holds.
9. Reload. See: the composer cards are still there with their requests and
   answers.
10. Run `/model.list`, click `Maximize card`, click `Compose` in the detail
    pane. See: the pane closes and the composer is at the tail.

Cmd+K doors for the same acts: `/model.compose loopback-jev`,
`/model.ask loopback-jev`, `/model.recall loopback-jev`,
`/model.fixture loopback-jev`.

## 13. One real paid call

The loopback provider cannot prove a vendor accepts our bytes. With
`CEREBRAS_API_KEY` exported in Terminal B's shell, run `/model.list`.
See: a host row `cerebras`. Click `Test`. See: green with a real latency
(228 ms when this script was written). Its detail reads Model `qwen-3.8-27b`,
URL `https://api.cerebras.ai`, Credential `CEREBRAS_API_KEY`.

Then `New`: Name `cerebras-revoked`, Protocol `openai-chat`, Base URL
`https://api.cerebras.ai`, Model as on the `cerebras` row, Credential
`REVOKED`. `Test`. See: `endpoint_forbidden`. `REVOKED` is pinned to your
loopback origin, so the vendor never sees it.

## 14. The automated receipt

```sh
cd ~/smithers/apps/app
lsof -nP -iTCP:47321 -sTCP:LISTEN     # must print nothing
SMITHERS_REAL_PORT=47401 SMITHERS_CHAT_STUB=0 pnpm run test:e2e:real --grep models --trace off
```

If port 47321 is taken, leave its owner alone and add `SMITHERS_REAL_PORT=47391`
in front of the command. `SMITHERS_MODEL_PROVIDER_PORT=<port>` fixes the
loopback provider's port; unset, the runner takes a free one before the host
boots.

See: `22 passed` in about a minute. The command then prints the quality gate.
The gate's errors, if any, name other specs, never `models.spec.ts`.

The enrollment scenario reads the actual OPFS SQLite tables after the UI steps,
checks the host request log, and checks the provider journal's SHA-256 values.
It uses real browser input, the real local host and the real macOS keychain.
Playwright tracing remains off for credential entry.
