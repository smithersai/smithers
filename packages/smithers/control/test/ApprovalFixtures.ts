import { Effect } from "effect"
import * as ApprovalAuthority from "../src/ApprovalAuthority.vibe"
import type { Principal } from "../src/ControlSchema.ts"

/** Explicit test-host delegation; production defaults remain exercised by the authority suites. */
export const delegateApproval = (...principals: ReadonlyArray<Pick<Principal, "id" | "kind">>) =>
  Effect.runSync(ApprovalAuthority.make([
    { id: "local", kind: "operator" },
    { id: "memory", kind: "test" },
    ...principals
  ].map(({ id, kind }) => ({
    principal: { id, kind },
    scopes: ["once", "run", "remembered"],
    targets: ["Plan", "Node"]
  }))))
