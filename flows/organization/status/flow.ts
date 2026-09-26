/**
 * `organization/status`: rewrites the organization's status page from the
 * delivery receipts under its generated directory.
 */
import { Flow } from "@smthrs/flow"
import { WriteStatus } from "../schema.ts"

/** Rewrite the status page. */
export default Flow.make("organization/status", {
  description: "Rewrite the organization's status page from the delivery receipts under its generated directory.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: {},
  success: WriteStatus.successSchema,
  error: WriteStatus.errorSchema,
  body: () => WriteStatus.call({})
})
