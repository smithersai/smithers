import { describe, expect, it } from "vitest"
import * as HostProbes from "../src/internal/HostProbes.ts"

describe("HostProbes", () => {
  it("runs one probe per key and shares the in-flight promise with concurrent callers", async () => {
    const probes = HostProbes.make()
    let runs = 0
    let release: (value: string) => void = () => {}
    const gate = new Promise<string>((resolve) => {
      release = resolve
    })
    const probe = () => {
      runs += 1
      return gate
    }
    const first = probes.once(["docker", "/usr/bin/docker", ["--version"], "env"], probe)
    const second = probes.once(["docker", "/usr/bin/docker", ["--version"], "env"], probe)
    expect(runs).toBe(1)
    release("Docker version 27")
    expect(await Promise.all([first, second])).toEqual(["Docker version 27", "Docker version 27"])
    expect(await probes.once(["docker", "/usr/bin/docker", ["--version"], "env"], probe)).toBe("Docker version 27")
    expect(runs).toBe(1)
  })

  it("keeps distinct arguments, executables and environments on distinct probes", async () => {
    const probes = HostProbes.make()
    const seen: Array<string> = []
    const probe = (name: string) => () => {
      seen.push(name)
      return Promise.resolve(name)
    }
    await probes.once(["docker", "/a/docker", ["--version"], "one"], probe("version"))
    await probes.once(["docker", "/a/docker", ["info"], "one"], probe("info"))
    await probes.once(["docker", "/b/docker", ["--version"], "one"], probe("other binary"))
    await probes.once(["docker", "/a/docker", ["--version"], "two"], probe("other environment"))
    expect(seen).toEqual(["version", "info", "other binary", "other environment"])
  })

  it("digests environments by content, ignoring order and undefined entries", () => {
    expect(HostProbes.environmentKey({ PATH: "/a", HOME: "/h" })).toBe(
      HostProbes.environmentKey({ HOME: "/h", PATH: "/a", GONE: undefined })
    )
    expect(HostProbes.environmentKey({ PATH: "/a" })).not.toBe(HostProbes.environmentKey({ PATH: "/b" }))
    expect(HostProbes.environmentKey(undefined)).toBe("ambient")
  })
})
