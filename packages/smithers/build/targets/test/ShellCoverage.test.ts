import { describe, expect, it } from "vitest"
import * as Reference from "../src/Reference.ts"
import * as Shell from "../src/Shell.ts"

describe("Shell exec payload boundary values", () => {
  it("retains literal argv order and workspace flag sentinel references", () => {
    const flag = Reference.FlagRef.make({ name: "jobs" })
    const payload = Shell.execPayload({
      bin: Reference.runtimeBin,
      args: ["run", flag, "entry.ts"]
    })
    expect(payload.argv).toEqual([
      Shell.toolToken(Reference.runtimeBin),
      "run",
      Shell.flagToken("jobs"),
      "entry.ts"
    ])
  })

  it("copies an explicitly declared environment into the exec payload", () => {
    const env = { BUILD_MODE: "release" }
    const payload = Shell.execPayload({ shell: "echo ready", env })
    expect(payload.env).toEqual({ BUILD_MODE: "release" })
    expect(payload.env).not.toBe(env)
    env.BUILD_MODE = "debug"
    expect(payload.env).toEqual({ BUILD_MODE: "release" })
  })
})

describe("a shell test that asks to be observed", () => {
  it("is declared with a run nothing confines", () => {
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: true })).not.toThrow()
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: { ignore: ["~/.cache/tool/logs"] } }))
      .not.toThrow()
    expect(() => Shell.Test({ shell: "true", observe: false })).not.toThrow()
    expect(() => Shell.Test({ shell: "true" })).not.toThrow()
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: true, shards: 1, services: [] }))
      .not.toThrow()
  })

  it("is refused under a confinement, with shards and with services", () => {
    expect(() => Shell.Test({ shell: "true", observe: true })).toThrow(/observe requires sandbox: "none"/)
    expect(() => Shell.Test({ shell: "true", sandbox: { network: true }, observe: true }))
      .toThrow(/observe requires sandbox: "none"/)
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: true, shards: 2 }))
      .toThrow(/observe cannot be combined with shards/)
    const service = Shell.Serve({ shell: "serve" })
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: true, services: [service] }))
      .toThrow(/observe cannot be combined with services/)
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: { ignore: [""] } })).toThrow()
  })

  it("names the host variables it is given whose values are no part of its key", () => {
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: { env: ["CI_COMMIT"] } })).not.toThrow()
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: { ignore: [], env: [] } })).not.toThrow()
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: {}, inheritEnv: ["CI_COMMIT"] })).not.toThrow()
    expect(Shell.observedEnv({ env: ["CI_COMMIT", "CI_RUN"] })).toEqual(["CI_COMMIT", "CI_RUN"])
    expect(Shell.observedEnv({ ignore: ["logs"] })).toEqual([])
    expect(Shell.observedEnv(true)).toEqual([])
    expect(Shell.observedEnv(undefined)).toEqual([])
    expect(Shell.observedEnv(null)).toEqual([])
  })

  it("refuses a variable that is no name, or that the target also sets or inherits", () => {
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: { env: ["not a name"] } })).toThrow()
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: { env: ["A", "B"] }, inheritEnv: ["B"] }))
      .toThrow(/observe\.env names B, which env or inheritEnv also names; declare each variable once/)
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: { env: ["A"] }, env: { A: "1" } }))
      .toThrow(/observe\.env names A, which env or inheritEnv also names/)
    expect(() => Shell.Test({ shell: "true", sandbox: "none", observe: { env: ["A"] }, env: { B: "1" } }))
      .not.toThrow()
  })
})

describe("a shell target that names a machine", () => {
  it("is declared with a run nothing confines", () => {
    expect(() => Shell.Test({ shell: "true", sandbox: "none", machine: "ci.yml:lint" })).not.toThrow()
    expect(() => Shell.Test({ shell: "true", sandbox: "none", machine: "ci.yml:lint", observe: true })).not.toThrow()
    expect(() => Shell.Build({ shell: "true", sandbox: "none", machine: "job", cache: false, outFiles: ["//out"] }))
      .not.toThrow()
    expect(() => Shell.Test({ shell: "true", sandbox: "none", machine: "job", shards: 1, services: [] })).not.toThrow()
  })

  it("is refused under a confinement, with shards, with services, and as a build that is cached", () => {
    expect(() => Shell.Test({ shell: "true", machine: "job" })).toThrow(/machine requires sandbox: "none"/)
    expect(() => Shell.Test({ shell: "true", sandbox: { network: true }, machine: "job" }))
      .toThrow(/machine requires sandbox: "none"/)
    expect(() => Shell.Test({ shell: "true", sandbox: "none", machine: "job", shards: 2 }))
      .toThrow(/machine cannot be combined with shards/)
    const service = Shell.Serve({ shell: "serve" })
    expect(() => Shell.Test({ shell: "true", sandbox: "none", machine: "job", services: [service] }))
      .toThrow(/machine cannot be combined with services/)
    expect(() => Shell.Test({ shell: "true", sandbox: "none", machine: "" })).toThrow()
    expect(() => Shell.Build({ shell: "true", machine: "job", cache: false, outFiles: ["//out"] }))
      .toThrow(/machine requires sandbox: "none"/)
    expect(() => Shell.Build({ shell: "true", sandbox: "none", machine: "job", outFiles: ["//out"] }))
      .toThrow(/machine requires cache: false/)
  })
})
