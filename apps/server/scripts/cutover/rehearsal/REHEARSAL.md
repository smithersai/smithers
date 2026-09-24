# Isolated binding round-trip rehearsal

The installer re-sends each Worker's original non-secret bindings on upload and keeps secrets by identity (`keep_bindings: ["secret_text"]`). Before this rehearsal, that round trip was proven live only for Durable Object, assets and plain_text bindings. This rehearsal proves the other binding types the 14 authorities use (d1, r2_bucket, kv_namespace, queue, ratelimit) on scratch resources. It uses the production installer code path unchanged.

**Blast radius.** It creates 2 Workers, 1 D1 database, 1 R2 bucket, 1 KV namespace and 2 queues, all named `smithers-cutover-rehearsal-*`. It references no production resource. `install.ts --rehearsal` refuses any Worker outside `^smithers-cutover-rehearsal-[a-z0-9]{1,24}$` and any of the 14 authority names. Rate-limit namespace `97001` is unused in the account (observed 2026-09-24: 1001, 1002, 818195156, 818195157, 1080021003, 2144259474).

**Status: prepared, not executed.** Root reviews and runs it.

## What passes

| Phase | Probe `/selftest` must return | Proves |
| --- | --- | --- |
| baseline | 200: d1-ok, r2-ok, kv-ok, queue sent, ratelimit answers, assets-ok, MODE, secret digest | Scratch wiring |
| admission | 200, **identical facts and secret digest** | Every re-sent binding still reaches the same resource; the secret value survived `keep_bindings` |
| fenced | 503 `cutover_maintenance` | The fence removes Durable Object writer authority |
| restored | 200, identical to baseline | Exact rollback to the original version id |

The installer also runs its own provider-side checks on every step and refuses on any difference: non-secret bindings equal the original, secret names equal original + 5 maintenance names, DO namespace ids equal, module digests equal. Restore requires the exact original version id, modules, and settings (annotations excepted).

Local dress rehearsal on real workerd (`local.test.ts`) already passes. It cannot prove Cloudflare's own re-serialization; only this remote run can.

## Commands (root; `CLOUDFLARE_API_TOKEN` = control token; run from `apps/server/scripts/cutover/rehearsal`)

```sh
# 1. Scratch resources
npx wrangler d1 create smithers-cutover-rehearsal-r1                  # note database_id
npx wrangler d1 execute smithers-cutover-rehearsal-r1 --remote \
  --command "CREATE TABLE rehearsal (k TEXT PRIMARY KEY, v TEXT); INSERT INTO rehearsal VALUES ('probe','d1-ok')"
npx wrangler r2 bucket create smithers-cutover-rehearsal-r1
printf 'r2-ok\n' > /tmp/r2-probe.txt && npx wrangler r2 object put smithers-cutover-rehearsal-r1/probe.txt --file /tmp/r2-probe.txt --remote
npx wrangler kv namespace create smithers-cutover-rehearsal-r1        # note id
npx wrangler kv key put probe kv-ok --namespace-id <KV_ID> --remote
npx wrangler queues create smithers-cutover-rehearsal-r1
npx wrangler queues create smithers-cutover-rehearsal-r1-dlq

# 2. Scratch + probe Workers (fill <D1_ID>, <KV_ID> in wrangler.scratch.jsonc first)
npx wrangler deploy -c wrangler.scratch.jsonc
openssl rand -hex 32 | npx wrangler secret put REHEARSAL_SECRET -c wrangler.scratch.jsonc   # value never printed
npx wrangler deploy -c wrangler.probe.jsonc
P=https://smithers-cutover-rehearsal-p1.<account-subdomain>.workers.dev

# 3. Private dir, export credential, expected identity
R=$(mktemp -d) && chmod 700 $R && bun ../keys.ts $R/x && mv $R/x/recipient.json $R/ && rm -rf $R/x
jq -n --arg id "$(jq -r .migrationId $R/recipient.json)" '{executionID:$id,smithersRevision:"<candidate smithers sha>",plueRevision:"<candidate plue sha>",endpoint:"https://api.jjhub.tech"}' > $R/expected.json && chmod 600 $R/expected.json
V=$(mktemp -d) && chmod 700 $V

# 4. Rehearse with the real installer and the gate's real authorization hook
export SMITHERS_CUTOVER_AUTHORIZE=<gate hook>
bun verify.ts $P baseline $V
PLAN=$(bun ../install.ts prepare $R --rehearsal smithers-cutover-rehearsal-r1 | jq -r .planSHA256)
bun ../install.ts apply $R $PLAN admission                  # previews-off, admission
bun verify.ts $P admission $V
bun ../install.ts apply $R $PLAN fence
bun verify.ts $P fenced $V
bun ../install.ts restore $R $PLAN
bun verify.ts $P restored $V
bun ../install.ts status $R $PLAN                           # expect state "original"

# 5. Teardown (scratch only)
npx wrangler delete -c wrangler.probe.jsonc
npx wrangler delete -c wrangler.scratch.jsonc
npx wrangler queues delete smithers-cutover-rehearsal-r1-dlq
npx wrangler queues delete smithers-cutover-rehearsal-r1
npx wrangler kv namespace delete --namespace-id <KV_ID>
npx wrangler r2 object delete smithers-cutover-rehearsal-r1/probe.txt --remote && npx wrangler r2 bucket delete smithers-cutover-rehearsal-r1
npx wrangler d1 delete smithers-cutover-rehearsal-r1
rm -rf $R $V
```

Any `{"refused":CODE}` stops the run. On a refused apply, run `restore` and `status` before teardown.

## Known behaviour to expect
- Under admission and fence, the scratch queue consumer throws (only chat-canary keeps its consumer). Selftest messages retry and then land in `smithers-cutover-rehearsal-r1-dlq`. That is the production retain-not-ACK semantics, not a failure.
- `preview_urls: true` is deliberate, so the previews-off and previews-restore steps are rehearsed too.
