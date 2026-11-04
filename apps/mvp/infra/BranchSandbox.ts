// The branch sandbox's container (decision 0013 §9, docs/features/branch-workspace.md#the-machine): one image, built
// from infra/sandbox/Dockerfile, that each branch's `SandboxObject` (worker/BranchSandboxes.ts) starts on demand under
// the `durable_object` scheduling policy, one container per branch. Alchemy builds it, pins it by digest and prepares
// it before the Worker is uploaded; `alchemy dev` runs it through local workerd and Docker. A deployment that sets
// SANDBOX_IMAGE, an image already in Cloudflare's registry by digest and built from that Dockerfile or one extending it
// (infra/gate/Dockerfile), deploys it as is and builds nothing, so a machine without Docker can deploy. Per-instance
// settings go to `start()`, never here: the policy refuses deployment-wide ones, `maxInstances` among them ("The
// `durable_object` policy does not support `max_instances`"). The cap on awake machines is the sandbox admission
// (worker/branch/Budget.ts, decision 0103), which fails closed.
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Config, Effect, Option } from "effect"

/** SANDBOX_IMAGE when set (a prebuilt image by digest), else infra/sandbox, built by the deploy. */
export const sandboxImage = Config.option(Config.String("SANDBOX_IMAGE")).pipe(
  Config.map(Option.flatMap((image) => image.trim() === "" ? Option.none() : Option.some(image.trim()))),
)

export class BranchSandbox extends Cloudflare.Container<BranchSandbox>()(
  "BranchSandbox",
  Effect.map(Effect.orDie(sandboxImage), (image) =>
    Option.isSome(image)
      ? { schedulingPolicy: "durable_object" as const, image: image.value }
      : { schedulingPolicy: "durable_object" as const, context: `${import.meta.dirname}/sandbox` }),
) {}
