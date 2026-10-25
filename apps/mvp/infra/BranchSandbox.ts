// The branch sandbox's container (decision 0013 §9, docs/features/branch-workspace.md#the-machine): one image, built
// from infra/sandbox/Dockerfile, that each branch's `SandboxObject` (worker/BranchSandboxes.ts) starts on demand under
// the `durable_object` scheduling policy, one container per branch. Alchemy builds it, pins it by digest and prepares
// it before the Worker is uploaded; `alchemy dev` runs it through local workerd and Docker. Per-instance settings go to
// `start()`, never here: the policy refuses deployment-wide ones, `maxInstances` among them ("The `durable_object`
// policy does not support `max_instances`"). The cap on awake machines is the sandbox admission
// (worker/branch/Budget.ts, decision 0103), which fails closed.
import * as Cloudflare from "alchemy/Cloudflare"

export class BranchSandbox extends Cloudflare.Container<BranchSandbox>()("BranchSandbox", {
  schedulingPolicy: "durable_object",
  context: `${import.meta.dirname}/sandbox`,
}) {}
