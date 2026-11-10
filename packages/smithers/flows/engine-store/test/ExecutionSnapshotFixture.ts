import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect, Layer } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Migrations from "../src/Migrations.vibe"

export const onFile = <A, E>(
  filename: string,
  body: Effect.Effect<A, E, SqlClient.SqlClient | DurableWriter.DurableWriter>
) =>
  Effect.scoped(body.pipe(Effect.provide(Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename })))))

export const fixture = <A, E>(body: (filename: string) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "execution-snapshot-")))
    const filename = join(directory, "engine.db")
    try {
      yield* onFile(filename, Migrations.run)
      return yield* body(filename)
    } finally {
      yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
    }
  })

export const state = JSON.stringify({ version: 1, flowName: "test", payload: {} })
