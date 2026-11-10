// The platform code of 19-cancel-and-child-cleanup.vibe, which a .vibe file does not import as a value (EK4402).

import { Capability } from "@smthrs/flows"
import { NodeRuntime } from "@smthrs/platform-node"
import type * as Layer from "effect/Layer"
import { dirname } from "node:path"

/** The engine, on the real Node host, with permission to spawn. */
export const host = <Registered, RegistrationRequirements>(
  filename: string,
  hostId: string,
  registrations: Layer.Layer<Registered, never, RegistrationRequirements>
) =>
  NodeRuntime.layerHost(
    {
      filename,
      workspaceRoot: dirname(filename),
      owner: { hostId },
      // No signal handlers: the example is the one deciding when things stop.
      signals: [],
      rules: [
        new Capability.Permission.Rule({
          effect: "allow",
          pattern: new Capability.Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
        })
      ]
    },
    registrations
  )

/**
 * Whether a process group still exists.
 *
 * @throws {never}
 */
export const groupIsAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}
