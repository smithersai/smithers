// The gate's job machine (decision 0128 (c), docs/features/ci.md#machines): its own container class, from the prebuilt
// gate image the deployment names by digest (GATE_IMAGE, infra/gate/Dockerfile), started by each `GateObject`
// (worker/BranchSandboxes.ts) on GATE_INSTANCE, as `BranchSandbox` is by each `SandboxObject`. An image already in
// Cloudflare's registry is deployed as is; Alchemy builds nothing. Declared only when GATE_IMAGE is set
// (worker/branch/JobMachines.ts): nothing binds it otherwise.
//
// `CiArtifacts` is the R2 bucket the gate's boxes keep their run's artifacts in (worker/branch/Artifacts.ts), declared
// with the gate machine. Its objects expire 7 days after they were written.
import * as Cloudflare from "alchemy/Cloudflare"
import { Config, Effect } from "effect"

/** The gate machine's container class: the GATE_IMAGE image, which only a deployment that sets it binds. */
export class GateMachine extends Cloudflare.Container<GateMachine>()(
  "GateMachine",
  Effect.map(Config.String("GATE_IMAGE"), (image) => ({ schedulingPolicy: "durable_object" as const, image: image.trim() })),
) {}

/** How long an artifact lives: 7 days. */
export const ARTIFACT_DAYS = 7

/** The run artifacts' bucket, each object deleted 7 days after it was written. */
export const CiArtifacts = Cloudflare.R2.Bucket("CiArtifacts", {
  lifecycleRules: [{
    id: "expire-artifacts",
    deleteObjectsTransition: { condition: { type: "Age", maxAge: ARTIFACT_DAYS * 24 * 60 * 60 } },
  }],
})
