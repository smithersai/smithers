# Messages shard sync and telemetry

Each conversation replicates through a Durable Object SQLite shard (`MessagesShardObject`) governed by the formal reducer in `@smthrs/app-state` and `lean/smithers-state/SmithersState/Chat.lean` (ADR 0170).

## Admission and wire limits

- Submit routes enforce a 192 KiB cap (`MAX_MESSAGES_SHARD_BYTES`, 196,608 bytes), sized to carry the longest reducer body (32,000 UTF-16 code units at up to 6 bytes per unit in JSON UTF-8) plus envelope fields.
- Both Worker admission (`dispatch`) and the Durable Object (`handle`) preserve leading UTF-8 byte-order marks (`preserveBom = true`), so malformed JSON, invalid UTF-8, or BOM-prefixed submits fail with HTTP 400 before forwarding.
- Public posts under lowercase-UUID message ids are refused atomically at the sequencer with HTTP 403 `reserved`. Only the post-commit bridge writers (`person:question:<questionId>` and `answer:<answerId>`) may claim those ids.
- Non-person `role: "user"` posts and `UpdateMessageBody` requests targeting a question are classified as `person_only` before author checks, keeping `auth.person_only` and `smithers_person_only_refusals` complete.

## Post-commit bridge telemetry

`chat.shard.bridge` (Warn log) and `smithers_messages_shard_bridge_writes` (counter with bounded `write` and `outcome` labels) record post-commit dual writes from `POST /api/questions` and `conversation_respond` into each conversation shard.

Unknown reducer reasons and refusal headers normalize to `other`, and non-UUID conversation ids are omitted from structured logs. Bridge authors and journal keys use opaque message-scoped names (`person:question:<questionId>` and `answer:<answerId>`), so message text and server-only asker ids never enter logs, metrics, pull streams, or snapshots.
