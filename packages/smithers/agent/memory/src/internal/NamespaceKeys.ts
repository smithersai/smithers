/**
 * The fifth memory migration: note and thread ids are scoped to a namespace.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Rebuilds `memory_notes`, `memory_note_supersedes`, `memory_threads` and
 * `memory_messages` so the namespace leads every primary and foreign key,
 * as it already does on `memory_facts`.
 *
 * Before this migration a note id and a thread id were global: two namespaces
 * could not both hold the id `prefs`, and a read, update or delete keyed by
 * the bare id reached whichever namespace held it. Every existing row keeps
 * its id and stays in the namespace it was written to. An edge and a message
 * take the namespace of the note and the thread they belong to; a message
 * whose thread row is gone had no namespace and no reader, and is not copied.
 *
 * Both dialects rebuild by copy, because neither can widen a primary key that
 * a foreign key references in place. A database whose messages already carry
 * the namespace is left as it is, so the migration is safe to run again.
 *
 * @category migrations
 * @since 1.0.0
 */
export const namespaceKeys = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const integer = Dialect.integer(sql)
  const messageColumns = yield* Dialect.columns(sql, "memory_messages")
  if (messageColumns.some((column) => column.name === "namespace_kind")) return

  yield* sql`CREATE TABLE memory_notes_scoped (
    namespace_kind TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (length(id) > 0),
    text TEXT NOT NULL,
    tags_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`tags_json`)}),
    provenance_json TEXT NOT NULL CHECK (${Dialect.jsonValid(sql, sql`provenance_json`)}),
    status TEXT NOT NULL DEFAULT 'accepted',
    created_at_ms ${integer} NOT NULL,
    status_at_ms ${integer},
    accepted_todo TEXT,
    PRIMARY KEY (namespace_kind, namespace_id, id),
    CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
    CHECK (length(namespace_id) > 0),
    CHECK (status IN ('pending', 'accepted', 'rejected'))
  )`
  yield* sql`INSERT INTO memory_notes_scoped (
      namespace_kind, namespace_id, id, text, tags_json, provenance_json, status, created_at_ms,
      status_at_ms, accepted_todo
    )
    SELECT namespace_kind, namespace_id, id, text, tags_json, provenance_json, status, created_at_ms,
      status_at_ms, accepted_todo
    FROM memory_notes`
  yield* sql`CREATE TABLE memory_note_supersedes_scoped (
    namespace_kind TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    superseder_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at_ms ${integer} NOT NULL,
    PRIMARY KEY (namespace_kind, namespace_id, superseder_id, target_id),
    FOREIGN KEY (namespace_kind, namespace_id, superseder_id)
      REFERENCES memory_notes_scoped (namespace_kind, namespace_id, id),
    FOREIGN KEY (namespace_kind, namespace_id, target_id)
      REFERENCES memory_notes_scoped (namespace_kind, namespace_id, id),
    CHECK (superseder_id <> target_id)
  )`
  yield* sql`INSERT INTO memory_note_supersedes_scoped (
      namespace_kind, namespace_id, superseder_id, target_id, created_at_ms
    )
    SELECT superseder.namespace_kind, superseder.namespace_id, edges.superseder_id, edges.target_id,
      edges.created_at_ms
    FROM memory_note_supersedes edges
    JOIN memory_notes superseder ON superseder.id = edges.superseder_id
    JOIN memory_notes target ON target.id = edges.target_id
      AND target.namespace_kind = superseder.namespace_kind
      AND target.namespace_id = superseder.namespace_id`
  yield* sql`DROP TABLE memory_note_supersedes`
  yield* sql`DROP TABLE memory_notes`
  yield* sql`ALTER TABLE memory_notes_scoped RENAME TO memory_notes`
  yield* sql`ALTER TABLE memory_note_supersedes_scoped RENAME TO memory_note_supersedes`
  yield* sql`CREATE INDEX memory_notes_namespace_order_idx
    ON memory_notes (namespace_kind, namespace_id, created_at_ms, id)`
  // Default note reads ask "is this note superseded?", a lookup by target
  // that the primary key, which leads with the superseder, cannot answer.
  yield* sql`CREATE INDEX memory_note_supersedes_target_idx
    ON memory_note_supersedes (namespace_kind, namespace_id, target_id, superseder_id)`

  yield* sql`CREATE TABLE memory_threads_scoped (
    namespace_kind TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    thread_id TEXT NOT NULL CHECK (length(thread_id) > 0),
    title TEXT,
    metadata_json TEXT CHECK (metadata_json IS NULL OR ${Dialect.jsonValid(sql, sql`metadata_json`)}),
    created_at_ms ${integer} NOT NULL,
    updated_at_ms ${integer} NOT NULL,
    PRIMARY KEY (namespace_kind, namespace_id, thread_id),
    CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
    CHECK (length(namespace_id) > 0)
  )`
  yield* sql`INSERT INTO memory_threads_scoped (
      namespace_kind, namespace_id, thread_id, title, metadata_json, created_at_ms, updated_at_ms
    )
    SELECT namespace_kind, namespace_id, thread_id, title, metadata_json, created_at_ms, updated_at_ms
    FROM memory_threads`
  yield* sql`CREATE TABLE memory_messages_scoped (
    namespace_kind TEXT NOT NULL,
    namespace_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (length(id) > 0),
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    at_ms ${integer} NOT NULL,
    PRIMARY KEY (namespace_kind, namespace_id, thread_id, id),
    FOREIGN KEY (namespace_kind, namespace_id, thread_id)
      REFERENCES memory_threads_scoped (namespace_kind, namespace_id, thread_id)
  )`
  yield* sql`INSERT INTO memory_messages_scoped (
      namespace_kind, namespace_id, thread_id, id, role, text, at_ms
    )
    SELECT threads.namespace_kind, threads.namespace_id, messages.thread_id, messages.id, messages.role,
      messages.text, messages.at_ms
    FROM memory_messages messages
    JOIN memory_threads threads ON threads.thread_id = messages.thread_id`
  yield* sql`DROP TABLE memory_messages`
  yield* sql`DROP TABLE memory_threads`
  yield* sql`ALTER TABLE memory_threads_scoped RENAME TO memory_threads`
  yield* sql`ALTER TABLE memory_messages_scoped RENAME TO memory_messages`
  yield* sql`CREATE INDEX memory_messages_thread_order_idx
    ON memory_messages (namespace_kind, namespace_id, thread_id, at_ms, id)`
})
