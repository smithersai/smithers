import { createHash, timingSafeEqual } from "node:crypto"

/*
 * The executor pod's shared token. The container listens on the pod network,
 * where the coordinator is the ONLY legitimate client but not the only
 * possible caller: anything else that reaches the pod IP (another workload in
 * the cluster, a confused neighbor) could otherwise drive /execute — rewrite
 * the example repository mid-run and have the result presented to the visitor
 * as their verified fix. The coordinator generates one token per session,
 * injects it as this env var into the pod spec, and sends it as this header
 * on every call; both sides read the names from here so they cannot drift.
 */
export const EXECUTOR_TOKEN_ENV = "TUTORIAL_EXECUTOR_TOKEN"
export const EXECUTOR_TOKEN_HEADER = "x-tutorial-executor-token"

/**
 * Whether a caller-supplied header value satisfies the deployed token.
 *
 * Missing configuration fails closed on every interface, including local
 * development. Compare fixed-length digests so token lengths do not affect
 * the comparison. Local callers must also configure and supply a token.
 */
export const executorTokenAuthorized = (supplied: unknown, expected: string | undefined): boolean => {
  if (expected === undefined || expected === "") return false
  if (typeof supplied !== "string") return false
  const actual = createHash("sha256").update(supplied).digest()
  const want = createHash("sha256").update(expected).digest()
  return timingSafeEqual(actual, want)
}
