// Node can turn off TLS checks for a whole process through its environment, so a script that reaches a network refuses to
// run with that set, as its first line, whatever it targets (e2e/tls-checks.test.ts).

/** Throws if `env` has TLS checks off. */
export const refuseUncheckedTls = (env) => {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS checks are turned off in this environment: refusing to run")
}
