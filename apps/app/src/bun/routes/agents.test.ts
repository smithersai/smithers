import { expect, test } from "bun:test"
import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import { createAgentStore } from "./agents"

test("agent roles are immutable built-ins and reject custom launch identities", async () => {
  const store = createAgentStore()
  expect(await store.list()).toEqual(AGENT_ROLES)
  expect(await store.get("reviewer")).toBeUndefined()
  expect(await store.get(AGENT_ROLES[0]!.id)).toEqual(AGENT_ROLES[0])
})
