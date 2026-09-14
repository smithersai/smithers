import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLead } from "@smthrs/rpc/RefusalCopy"

/** Uncoded run failures belong to Smithers. Never infer blame from an error string. */
export function runFailure(detail = "") {
  let body: unknown
  try { body = JSON.parse(detail) } catch { body = undefined }
  const refusal = refusalOf({ body, status: null, message: detail })
  return { fault: refusal.fault, message: refusalLead(refusal), detail }
}
