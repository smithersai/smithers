import { expect, it } from "vitest"
import * as CiToolchain from "../src/CiToolchain.ts"
import { actions, GithubCiGen, toolchainSteps } from "../src/GithubCiGen.ts"
import * as Input from "../src/Input.ts"
import * as Nix from "../src/Nix.ts"
import * as Target from "../src/Target.ts"
import { packageManager } from "./toolchain.ts"

it("prepares a Nix toolchain without installing workspace dependencies when installation is disabled", () => {
  const attrs = Target.metadata(GithubCiGen({ packageManager })).attrs as Parameters<typeof toolchainSteps>[0]
  const steps = toolchainSteps(attrs, {
    id: "setup",
    runsOn: "ubuntu-latest",
    steps: [],
    toolchain: CiToolchain.Needs({
      install: false,
      nix: CiToolchain.Nix({ environment: Nix.Environment({ flake: Input.file("//flake.nix") }) })
    })
  })
  expect(steps).toEqual([
    { uses: actions.checkout, with: { "persist-credentials": "false" } },
    { name: "Install Nix", uses: actions.nixInstallerDeterminate }
  ])
})
