import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { randomBytes } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  maxSandboxInstances,
  sandboxContainerOptions,
  sandboxImageContext,
  sandboxImageRepository,
  sandboxToken,
  sandboxTokenVariable,
  sandboxWorkerEntry,
  sandboxWorkerOptions,
  workerCompatibilityDate,
  workerObservability
} from "../../deployment.ts"
import { sandboxInstanceTypes } from "../sandbox-instances.ts"

const infraRoot = fileURLToPath(new URL("../../", import.meta.url).href)
const read = (relative: string) => Fs.readFile(NodePath.join(infraRoot, relative), "utf8")

const configured = (value: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.map(sandboxToken, Redacted.value),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ [sandboxTokenVariable]: value }))
    )
  )

/**
 * Cloudflare's predefined instance types, from
 * https://developers.cloudflare.com/containers/platform-details/limits/.
 * `CloudflareSandbox` selects by `cpus` and `memoryMib` and cannot read the
 * deployed size back, so a declaration that drifts from these hands a session
 * a machine smaller than it asked for.
 */
const cloudflareSizes: Record<string, { readonly cpus: number; readonly memoryMib: number }> = {
  "standard-1": { cpus: 0.5, memoryMib: 4096 },
  "standard-2": { cpus: 1, memoryMib: 6144 },
  "standard-3": { cpus: 2, memoryMib: 8192 },
  "standard-4": { cpus: 4, memoryMib: 12_288 }
}

describe("sandbox service deployment", () => {
  it("declares instance types whose sizes are Cloudflare's, the 4-vCPU box first", () => {
    for (const instance of sandboxInstanceTypes) {
      expect(cloudflareSizes[instance.instanceType]).toEqual({ cpus: instance.cpus, memoryMib: instance.memoryMib })
      expect(instance.name).toBe(instance.instanceType)
    }
    expect(sandboxInstanceTypes[0].cpus).toBe(4)
    expect(new Set(sandboxInstanceTypes.map((instance) => instance.binding)).size).toBe(sandboxInstanceTypes.length)
    expect(new Set(sandboxInstanceTypes.map((instance) => instance.className)).size).toBe(sandboxInstanceTypes.length)
  })

  it("binds one container application per instance type and the token secret", () => {
    const containers: Array<{ readonly id: string; readonly props: unknown }> = []
    const options = sandboxWorkerOptions({
      container: (id, props) => {
        containers.push({ id, props })
        return `container:${id}`
      }
    })

    expect(options).toEqual({
      main: sandboxWorkerEntry,
      compatibility: { date: workerCompatibilityDate, flags: ["nodejs_compat"] },
      env: {
        SANDBOX_TOKEN: sandboxToken,
        SANDBOX_STANDARD_4: "container:SandboxStandard4",
        SANDBOX_STANDARD_3: "container:SandboxStandard3"
      },
      observability: workerObservability,
      workersDev: true
    })
    expect(containers).toEqual(sandboxInstanceTypes.map((instance) => ({
      id: instance.className,
      props: {
        className: instance.className,
        context: sandboxImageContext,
        instanceType: instance.instanceType,
        maxInstances: maxSandboxInstances,
        publish: { repository: sandboxImageRepository }
      }
    })))
    expect(sandboxContainerOptions(sandboxInstanceTypes[0]).instanceType).toBe("standard-4")
  })

  it("exports the Durable Object class every container application names", async () => {
    const entry = await read(sandboxWorkerEntry)

    for (const instance of sandboxInstanceTypes) {
      expect(entry).toContain(`export class ${instance.className} extends Sandbox {}`)
    }
    expect(entry).toContain(`from "@cloudflare/sandbox"`)
  })

  it("builds the machine image on the SDK's own image with the post-merge toolchain pinned", async () => {
    const dockerfile = await read(NodePath.join(sandboxImageContext, "Dockerfile"))
    const manifest = JSON.parse(await read("package.json")) as {
      readonly dependencies: Record<string, string>
    }
    const argument = (name: string) => new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1]

    // The SDK checks that its control server matches its own version.
    expect(dockerfile).toContain(`FROM docker.io/cloudflare/sandbox:${manifest.dependencies["@cloudflare/sandbox"]}\n`)
    expect(dockerfile).not.toMatch(/^ENTRYPOINT/m)
    expect(argument("NODE_VERSION")).toMatch(/^26\.\d+\.\d+$/)
    expect(argument("PNPM_VERSION")).toBe("11.25.0")
    expect(argument("BUN_VERSION")).toBe("1.4.4")
    expect(argument("GO_VERSION")).toMatch(/^\d+\.\d+\.\d+$/)
    expect(argument("JJ_VERSION")).toMatch(/^\d+\.\d+\.\d+$/)
    for (const download of ["NODE", "BUN", "GO", "JJ"]) {
      expect(argument(`${download}_SHA256`)).toMatch(/^[0-9a-f]{64}$/)
      expect(dockerfile).toContain(`echo "\${${download}_SHA256}`)
    }
    for (const tool of ["node --version", "pnpm --version", "bun --version", "go version", "jj --version", "git --version", "tar --version", "base64 --version"]) {
      expect(dockerfile).toContain(tool)
    }
  })

  it("hands the Worker the token itself, held to the cache credentials' rule", async () => {
    const minted = randomBytes(32).toString("hex")

    await expect(configured(minted)).resolves.toBe(minted)
    await expect(configured("short-token")).rejects.toThrow(`${sandboxTokenVariable} must be`)
    await expect(configured("x".repeat(64))).rejects.toThrow("must mix at least two of")
  })
})
