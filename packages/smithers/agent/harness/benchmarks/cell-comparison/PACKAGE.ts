import { Smithers } from "@smthrs/targets"

const offline = Smithers.Shell.Test({
  summary: "Validate matched benchmark receipts and all fifty task oracles in production QuickJS without model access.",
  script: Smithers.file("verify.sh"),
  data: [
    Smithers.glob("//packages/smithers/agent/harness/benchmarks/cell-comparison/*.{mjs,json,sh}"),
    Smithers.glob("//packages/smithers/agent/harness/benchmarks/cell-comparison/{observed-2026-11-05,probe-02,probe-03}/**")
  ],
  timeout: "1m"
})

export const Package = Smithers.Package({ targets: { offline } })
