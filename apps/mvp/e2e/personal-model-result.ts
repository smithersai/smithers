import { codeText } from "../src/features/personal-model/copy"

/** Explain a failed Test using known copy and a valid HTTP status; never echo a provider's response fields. */
export const personalModelTestDiagnostic = (result: unknown): string => {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return "failed"
  const { code, status } = result as { readonly code?: unknown; readonly status?: unknown }
  const reason = typeof code === "string" ? codeText(code) : "failed"
  const http = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? `; HTTP ${status}`
    : ""
  return `${reason}${http}`
}
