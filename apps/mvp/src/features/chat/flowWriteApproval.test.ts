import { digestSync } from "@smthrs/crypto"
import { Effect, Exit, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test, vi } from "vitest"
import { contents, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { cell, member, openAgent } from "../../test/agent"
import { renderSource } from "../flows-ui/source"
import { AnswerRun } from "../status/flows"

const runtime = testFile("chat_write_approval")
const query = <A>(run: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, run))

test("denying a saved-flow write in chat preserves its revision and code", async () => {
  const id = crypto.randomUUID()
  const name = "review"
  const source = (instructions: string) => renderSource({ name, description: "Review", flows: [], instructions })
  const original = source("Summarize my review.")
  await query(sql => sql`INSERT INTO flows (id, owner_id, name, revision, description, placement)
    VALUES (${id}::uuid, ${member.subject.id}, ${name}, 1, 'Review', 'client')`)
  await query(sql => sql`INSERT INTO flow_revisions (flow_id, revision, name, digest, source, created_by)
    VALUES (${id}::uuid, 1, ${name}, ${digestSync(original)}, ${original}, ${member.subject.id})`)
  const input = { name, revision: 1, source: source("Write my review.") }
  const turns: string[] = []
  const agent = await openAgent(runtime, request => {
    turns.push(contents(request).join("\n"))
    const program = turns.at(-1)!.includes("flow/write failed: NotApproved")
      ? 'ctx.done("Kept your flow.")'
      : `await ctx.call("flow/write", ${JSON.stringify(input)})`
    return Stream.make({ type: "text-delta" as const, id: "t", text: cell(program) }, usage, stop)
  })
  const engine = await agent.engine()
  try {
    const answer = await agent.ask("Change my review flow.")
    const running = agent.start(engine, answer)
    const wait = await vi.waitFor(async () => {
      const [row] = await query(sql => sql<{ version: number; wait: { execution: string; prompt: string } | null }>`
        SELECT version, wait FROM runs WHERE id = ${answer} AND status = 'needs_you'`)
      expect(row?.wait?.prompt).toBe("Save these changes to your flow?")
      return { version: row!.version, execution: row!.wait!.execution }
    }, { timeout: 20_000 })
    await Effect.runPromise(engine.flows.execute(AnswerRun, {
      executionId: `deny-${answer}`, payload: { runId: answer, ...wait, value: false },
    }))
    expect(await running.done).toEqual(Exit.succeed({ status: "done" }))
    expect(turns.some(turn => turn.includes("flow/write failed: NotApproved"))).toBe(true)
    expect(await query(sql => sql`SELECT revision, source FROM flow_revisions WHERE flow_id = ${id}::uuid`))
      .toEqual([{ revision: 1, source: original }])
  } finally {
    await engine.kill()
  }
})
