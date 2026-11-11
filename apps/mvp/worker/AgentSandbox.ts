import { Agent } from "@smthrs/agent"
import { Layer } from "effect"
import { variant } from "@smthrs/harness/QuickJSWorkerd"

// Composition kept under its existing app path for consumers; QuickJS/workerd variant creation is owned by harness.
export { variant, variantFrom } from "@smthrs/harness/QuickJSWorkerd"
export const layer = Agent.layerSandboxWithVariant.pipe(Layer.provide(variant))

/** The cell sandbox over the bundled QuickJS build, and no steering: a head's review agents (worker/flows/Checks.ts). */
export const defaults = Agent.layerDefaultsWithVariant.pipe(Layer.provide(variant))
