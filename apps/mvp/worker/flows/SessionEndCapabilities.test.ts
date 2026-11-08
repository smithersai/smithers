import { Flow } from "@smthrs/flow"
import { Context } from "effect"
import { expect, test } from "vitest"
import * as Recheck from "./RecheckRole.ts"
import * as Revoke from "./RevokeGitHubToken.ts"
import * as Cleanup from "./RevokeReplacedGitHubToken.ts"
import * as Keys from "./SessionSigningKeys.ts"

const ending = ["db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts"]
const capabilities = (declaration: { readonly annotations: Context.Context<never> }) => Context.get(declaration.annotations, Flow.Capabilities)
test("sign-out's flow and retained action names declare every transactional end write", () => {
  for (const declaration of [Revoke.RevokeGitHubToken, Revoke.EndSession, Revoke.RevokeToken, Revoke.ForgetTokens]) {
    expect(capabilities(declaration)).toEqual(expect.arrayContaining(ending))
  }
})
test("role refusal declares the alias and receipt writes as well as token cleanup", () => {
  for (const declaration of [Recheck.RecheckRole, Recheck.CheckRole]) expect(capabilities(declaration)).toEqual(expect.arrayContaining(ending))
})
test("the durable retention sweep declares role preservation and every terminal write", () => {
  for (const declaration of [Cleanup.SweepReplacedGitHubTokens, Cleanup.Sweep, Cleanup.MaintainSessions]) {
    expect(capabilities(declaration)).toEqual(expect.arrayContaining([...ending, "db:write:person_role_receipts"]))
  }
})
test("seal reset declares its one write and emergency drop keeps the full end ceiling", () => {
  expect(capabilities(Keys.ResetSealKey)).toEqual(["db:write:session_seal_key"])
  expect(capabilities(Keys.EmergencyDropSigningKey)).toEqual(expect.arrayContaining(ending))
})
