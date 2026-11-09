// Smithers discovers targets only in PACKAGE.ts.
import { Smithers } from "@smthrs/targets"

const inputs = [
  Smithers.glob("//packages/lemmascript/tools/**/*"),
  Smithers.glob("//packages/lemmascript/examples/**/*"),
  Smithers.file("//packages/lemmascript/package.json"),
]

/** The upstream test suite plus our patches' fixtures, through Dafny. */
const test = Smithers.Shell.Test({
  summary: "Build the vendored LemmaScript compiler and run its tests and Dafny fixtures.",
  shell: "pnpm --filter @smthrs/lemmascript build && { [ -x apps/vibelang/verify/.tools/bin/dafny ] || bash apps/vibelang/verify/install.sh; } && PATH=$PWD/apps/vibelang/verify/.tools/bin:$PATH pnpm --filter @smthrs/lemmascript test",
  data: inputs,
  timeout: "30m",
})

export const Package = Smithers.Package({ targets: { test } })
