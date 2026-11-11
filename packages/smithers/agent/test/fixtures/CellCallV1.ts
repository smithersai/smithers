import { Schema } from "effect"

// Archived wire declaration from 580c67600b^:packages/smithers/agent/harness/src/Cell.ts.
// Keep this independent of the current Cell module: it writes the pre-A2 fixture.
// flow_withheld added when CallFailureCode gained it (#1929).
const CallFailureCode = Schema.Literals([
  "unknown_flow",
  "capability_refused",
  "truncated_write",
  "declaration_changed",
  "invalid_input",
  "unimplemented",
  "timeout",
  "run_completed",
  "checkpoint_unavailable",
  "checkpoint_exhausted",
  "checkpoint_readonly",
  "checkpoint_unsupported",
  "flow_failed",
  "flow_withheld"
])

export class CallResult extends Schema.Class<CallResult>("flows/harness/Cell/CallResult")({
  outcome: Schema.Literals(["success", "failure"]),
  value: Schema.Json,
  message: Schema.optional(Schema.String),
  code: Schema.optional(CallFailureCode)
}) {}

// Historical rc.112 material remains pinned independently. Effect rc.115
// omits the default Union mode in SchemaRepresentation, changing sealed keys.
// Current main also folds boundary and declaration digests into the preimage;
// the rc.115 fixture pins that complete representation independently.
export const key = "key1_8ab2962732794ee8d8b3bf550657b41d475fd082ec9c8c7073b1d24a8d77d4b9"

// Moved again when `HarnessErrorCode` gained `completion_unjudged`, and once
// more when it gained `claim_unproven`: the wire declaration folded into the
// preimage carries the whole error union, so a new member is a new declaration
// digest and a new sealed key. That is what the digest is for. In-flight runs
// finish under the declaration they started on; a new run is keyed under this
// one. Moved when CallFailureCode gained flow_withheld (#1929), and when
// `HarnessError.cause` gained the typed `EvaluatorError` member (#2807), and
// when that member carried what a failed reading paid (#3010), and when
// `HarnessErrorCode` gained `completion_incomplete` (#3009).
export const effect115Key = "key1_425bb2aeef11571a366804d4700e45def8ac0aceac7c7c585b3e1f9461259283"

// The approval-channel declaration added `approval_unavailable` in
// 6206550ccc (#3161). Keep the preceding rc.115 vector above unchanged.
export const approvalRequiredKey = "key1_1e7f6586798d0220c9866f7d53e4d17ba33245e13e476b7e59ce3d080ec2fc8e"

// Reported evaluator charges add costUsd to the error declaration (#3824).
// Keep all earlier preimages unchanged.
export const reportedCostKey = "key1_5a55d5f0eb804f94c23df600642072cbe5e926f26ae6c8cbb549d3834bfcb68c"

// Moved when `HarnessError.cause` gained the provider's typed `ModelError`
// (9904ce12f1): the error declaration folded into the preimage changed, so the
// key moved under every key encoding, as a declaration change must (issue
// #120). The derivation did not move: with that commit's `HarnessError`
// swapped back, encoding 2 derives `reportedCostKey` byte for byte.
export const modelErrorCauseKey = "key1_c753452803048e450f3f45a4ff5b97455bc729f6c3011cc8364f4c344caf6208"

// Key encoding 3 (2026-10-21) writes `keyEncoding: 3` into the same material,
// so the current key names its derivation. Key encoding 2 still derives
// `modelErrorCauseKey`, and a run recorded under it replays there.
export const keyEncoding3Key = "key1_e389acc8bba469bfdf24e19262d93e98f8631fd8a1e4729747c93d7ecb960388"

// Key encoding 4 (2026-11-11, #4623) hashes the declaration's representation
// identity version 3, which includes what a JSON string decodes to. This
// declaration has no JSON string, so its material is encoding 3's under the
// new name. Key encoding 3 still derives `keyEncoding3Key`.
export const keyEncoding4Key = "key1_6e660a70edea56a06510877cbaa94eea27ffb96a7e7ce549344023d4cfb054cf"

// Moved when `HarnessErrorCode` gained `realm_exhausted` (#4829): the error
// union folded into the declaration grew a member, so the declaration digest
// and the key moved under every key encoding. The three keys above keep the
// preceding declaration's preimages. This material is the encoding-2 form;
// encodings 3 and 4 add `keyEncoding` to it.
export const realmExhaustedKey = "key1_2fb352392ce2a085f7f134eed416f7532ed7b90aa701a39c51b8b683c73c1458"
export const realmExhaustedEncoding3Key = "key1_8007b26b04c33c3d23975776270fdfc14aa23c8994200c034aa72689d7abb135"
export const realmExhaustedEncoding4Key = "key1_a703e449614ccfa068ebb77b8945c903552bbc94e0798e20a0ff58bbd08ac128"

// Independent JSON oracle. This fixture contains only JSON values, no schema
// classes, undefined, non-finite numbers or other normalization cases.
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, child]) => `${JSON.stringify(name)}:${canonical(child)}`).join(",")
    }}`
  }
  return JSON.stringify(value)
}
