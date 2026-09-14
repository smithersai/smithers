import type { SeamContext } from "./SeamContext"

export const SIGN_OUT_REFUSAL = "Sign in to Smithers Cloud to continue."

/** The controller selects the registered host door; prose never supplies a slash recipe. */
export const refuseCloudSignIn = (ctx: SeamContext, reason = SIGN_OUT_REFUSAL): string => {
  ctx.promptCloudSignIn?.()
  return ctx.actor() === "smithers"
    ? `${reason} Invoke cloud.prompt to offer the sign-in button.`
    : reason
}
