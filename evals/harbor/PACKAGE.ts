/**
 * Targets for the Harbor and Pier benchmark adapter.
 *
 * The offline fixture gates CI after the workspace install. Docker, a model
 * seat and a Harbor or Pier install remain documented operator commands: a
 * gate that needs a funded seat and a warm docker cache cannot hold a tree.
 */
import { Smithers } from "@smthrs/targets"

const offline = Smithers.Shell.Test({
  summary: "Check the Harbor adapter's prompt, environment, journal fold and trajectory without docker or a model.",
  script: Smithers.file("verify.sh"),
  data: [
    Smithers.glob("//evals/harbor/*.{py,md,sh}"),
    Smithers.glob("//evals/harbor/fixtures/**")
  ],
  timeout: "5m"
})

export const Package = Smithers.Package({
  targets: { offline }
})
