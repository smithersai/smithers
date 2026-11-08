import { Smithers } from "@smthrs/targets"

const offline = Smithers.Shell.Test({
  summary: "Validate matched benchmark receipts and all fifty task oracles in production QuickJS without model access.",
  script: Smithers.file("verify.sh"),
  data: [
    Smithers.glob("//packages/smithers/agent/harness/benchmarks/cell-comparison/*.{mjs,json,sh}")
  ],
  timeout: "1m"
})

export const Package = Smithers.Package({ targets: { offline } })
