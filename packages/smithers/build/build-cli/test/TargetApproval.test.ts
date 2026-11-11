/**
 * `approval: "required"` through the public CLI: the planner asks the host's
 * durable approval store for the exact revision before anything spawns, and a
 * granted revision runs every declared push in order against a real daemon
 * and an isolated registry; the store is the `RuntimeConfig.approvals` seam the unified
 * CLI fills with its control database.
 */
import { Smithers as S } from "@smthrs/targets"
import { Effect, Schedule } from "effect"
import { execFile, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { approvalRevision } from "../src/Cli.ts"
import * as DockerExec from "../src/DockerExec.ts"
import type * as PackageExec from "../src/PackageExec.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { dockerAvailable } from "./helpers/DockerProbe.ts"
import { writeExecutable } from "./helpers/Executable.ts"
import { serve } from "./helpers/ServeCli.ts"

const directories: Array<string> = []
const engineAvailable = dockerAvailable()
if (!engineAvailable) console.warn("Docker approval integration SKIPPED: no daemon answered docker info")
const dockerPath = PackageTree.findOnPath("docker")!
const execute = promisify(execFile)
const registryName = `smthrs-approval-${randomUUID()}`
const builderName = `smthrs-approval-${randomUUID()}`
let registry: string
const dockerConfig = process.env["DOCKER_CONFIG"] ?? Path.join(Os.homedir(), ".docker")
let buildxConfig: string
let builderCreated = false
let registryCreated = false
const recordedCalls: Array<string> = []
const docker = async (...args: Array<string>) =>
  execute(dockerPath, args, {
    env: { ...process.env, BUILDX_CONFIG: buildxConfig },
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  })

const registryAddress = async (name: string) => {
  const port = await docker(
    "inspect",
    "--format",
    "{{(index (index .NetworkSettings.Ports \"5000/tcp\") 0).HostPort}}",
    name
  )
  return `127.0.0.1:${port.stdout.trim()}`
}

/** A failed start may still have created the named container and its volume. */
const removeRegistry = async (name: string) => {
  await docker("rm", "--force", "--volumes", name).catch((error: { readonly stderr?: string }) => {
    if (!error.stderr?.includes("No such container:")) throw error
  })
}

const readyRegistry = async (address: string) => {
  await Effect.runPromise(
    Effect.tryPromise(async () => {
      const response = await fetch(`http://${address}/v2/`, { signal: AbortSignal.timeout(1000) })
      if (response.status !== 200) throw new Error(`Registry readiness: ${response.status}`)
    }).pipe(Effect.retry(Schedule.spaced("50 millis")), Effect.timeout("10 seconds"))
  )
}

beforeAll(async () => {
  if (!engineAvailable) return
  buildxConfig = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-approval-buildx-"))
  directories.push(buildxConfig)
  await docker("buildx", "create", "--name", builderName, "--driver", "docker-container", "--use")
  builderCreated = true
  registryCreated = true
  await docker("run", "--detach", "--name", registryName, "--publish", "127.0.0.1::5000", "registry:2.8.3")
  registry = await registryAddress(registryName)
  await readyRegistry(registry)
})

afterAll(async () => {
  try {
    if (engineAvailable) {
      try {
        const tags = new Set<string>()
        for (const file of recordedCalls) {
          const lines = (await Fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return ""
            throw error
          })).split("\n")
          for (const line of lines) if (line.startsWith("tag ")) tags.add(line.split(" ")[2]!)
        }
        if (tags.size > 0) await docker("image", "rm", "--force", ...tags)
      } finally {
        const results = await Promise.allSettled([
          ...(registryCreated ? [removeRegistry(registryName)] : []),
          ...(builderCreated ? [docker("buildx", "rm", "--force", builderName)] : [])
        ])
        expect(results.filter((result) => result.status === "rejected")).toEqual([])
      }
    }
  } finally {
    await Promise.all(directories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
  }
})

interface Fixture {
  readonly root: string
  readonly image: () => Promise<DockerExec.ArchiveImage>
  readonly calls: () => Promise<ReadonlyArray<string>>
  readonly environment: Record<string, string | undefined>
  readonly setTags: (tags: ReadonlyArray<string> | string) => Promise<void>
}

const packageSource = (tags: ReadonlyArray<string> | string, secrets = "[]", address = registry) =>
  `import { Smithers as S } from "@smthrs/targets"

const image = S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: ".", data: [S.file("hello.txt")] })
const push = S.Docker.Push({
  image,
  registry: "${address}",
  name: "fixture",
  tags: ${typeof tags === "string" ? tags : JSON.stringify(tags)},
  secrets: ${secrets},
  sandbox: "none",
  approval: "required"
})

export const Package = S.Package({ targets: { image, push } })
`

const literal = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Records the actual Docker argv while forwarding every operation to the real engine. */
const fixture = async (
  tags: ReadonlyArray<string> | string,
  options: { readonly secrets?: string; readonly registry?: string } = {}
): Promise<Fixture> => {
  const address = options.registry ?? registry
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-target-approval-")))
  directories.push(root)
  await Fs.mkdir(Path.join(root, ".smithers"))
  await Fs.writeFile(
    Path.join(root, ".smithers", "WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"

export const Workspace = S.Workspace("approval-fixture", {
  repository: "git+https://example.invalid/approval-fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  host: S.Host({ bins: ["docker"] })
})
`
  )
  await Fs.writeFile(
    Path.join(root, "package.json"),
    "{ \"name\": \"approval-fixture\", \"private\": true, \"packageManager\": \"pnpm@11.25.0\" }\n"
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await Fs.writeFile(Path.join(root, "Dockerfile"), "FROM scratch\nCOPY hello.txt /hello.txt\n")
  await Fs.writeFile(Path.join(root, "hello.txt"), "hello\n")
  await Fs.writeFile(Path.join(root, "PACKAGE.ts"), packageSource(tags, options.secrets, address))
  // The recorder logs every call outside the workspace: the image builds
  // from the context `.`, so a log inside the root would change its key.
  const bin = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-target-approval-bin-")))
  directories.push(bin)
  const log = Path.join(bin, "calls.txt")
  recordedCalls.push(log)
  const dockerEnvironment = [
    `DOCKER_CONFIG=${literal(dockerConfig)}`,
    `BUILDX_CONFIG=${literal(buildxConfig)}`,
    ...["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [`${name}=${literal(value)}`]
    })
  ].join(" ")
  await writeExecutable(
    Path.join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${literal(log)}
${dockerEnvironment} exec ${literal(dockerPath)} "$@"
`
  )
  return {
    root,
    environment: {
      ...process.env,
      BUILDX_CONFIG: buildxConfig,
      PATH: `${bin}${Path.delimiter}${process.env["PATH"] ?? ""}`
    },
    image: async () => {
      const declaration = S.Docker.Build({
        dockerfile: S.file("Dockerfile"),
        context: ".",
        data: [S.file("hello.txt")]
      })
      const directory = S.Target.metadata(declaration).outputs!.paths[0]!
      const image = await DockerExec.readImageArchive(Path.join(root, directory, "image.tar"))
      if ("error" in image) throw new Error(image.error)
      return image
    },
    calls: async () =>
      (await Fs.readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })).split("\n").filter((line) => line !== ""),
    setTags: (next) => Fs.writeFile(Path.join(root, "PACKAGE.ts"), packageSource(next, options.secrets, address))
  }
}

/** An in-memory store granting exactly the revisions in `approved`, recording every question. */
const memoryStore = (approved: Set<string> = new Set()) => {
  const asked: Array<PackageExec.TargetApprovalRequest> = []
  const store: PackageExec.TargetApprovals = {
    granted: async (request) => {
      asked.push(request)
      return approved.has(`${request.label}@${request.digest}`)
    }
  }
  return { store, asked, approve: (label: string, digest: string) => approved.add(`${label}@${digest}`) }
}

const pushes = (calls: ReadonlyArray<string>) => calls.filter((line) => line.startsWith("push "))

describe.skipIf(!engineAvailable)("approval: \"required\" through the public CLI", { timeout: 60_000 }, () => {
  it("refuses without an approval store and pushes nothing", async () => {
    const workspace = await fixture(["one", "two"])
    const result = await serve(workspace.root, ["//:push"], { environment: workspace.environment })

    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("this host has no approval store")
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("asks the store for the planned revision and refuses an unapproved one before any effect", async () => {
    const workspace = await fixture(["one", "two"])
    const memory = memoryStore()
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    const planned = await serve(workspace.root, ["//:push", "--plan"], {
      environment: workspace.environment,
      approvals: memory.store
    })
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })

    expect(revision).toEqual({
      root: workspace.root,
      label: "//:push",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(planned.output).toContain(revision.digest)
    expect(memory.asked).toEqual([revision, revision])
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain(
      `revision ${revision.digest.slice(0, 12)} is not approved; approve it with: smthrs approvals grant //:push`
    )
    expect(await workspace.calls()).not.toContainEqual(expect.stringMatching(/^(push|buildx build)/))
  })

  it("pushes every declared tag in order once the revision is approved", async () => {
    const workspace = await fixture(["one", "two", "three"])
    const memory = memoryStore()
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    memory.approve(revision.label, revision.digest)
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })

    expect(result.exitCode, `${result.output}${result.logs}`).toBe(0)
    const image = await workspace.image()
    const config = image.config
    const loadedId = (await workspace.calls()).find((line) => line.startsWith("tag "))?.split(" ")[1]
    expect([image.config, image.manifest]).toContain(loadedId)
    for (const tag of ["one", "two", "three"]) {
      const response = await fetch(`http://${registry}/v2/fixture/manifests/${tag}`, {
        headers: {
          Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
        }
      })
      expect(response.status).toBe(200)
      expect((await response.json() as { config: { digest: string } }).config.digest).toBe(config)
    }
    expect(pushes(await workspace.calls())).toEqual([
      `push ${registry}/fixture:one`,
      `push ${registry}/fixture:two`,
      `push ${registry}/fixture:three`
    ])
    // The push publishes the image the build produced: load its archive, then
    // tag that loaded image before each push and check the registry holds it.
    const calls = await workspace.calls()
    expect(calls, calls.join("\n")).toContainEqual(expect.stringMatching(/^load --input /))
    expect(calls.filter((line) => line.startsWith("tag ") || line.startsWith("push "))).toEqual([
      `tag ${loadedId} ${registry}/fixture:one`,
      `push ${registry}/fixture:one`,
      `tag ${loadedId} ${registry}/fixture:two`,
      `push ${registry}/fixture:two`,
      `tag ${loadedId} ${registry}/fixture:three`,
      `push ${registry}/fixture:three`
    ])
    expect(calls.filter((line) => line.startsWith("buildx imagetools"))).toEqual(
      Array.from({ length: 3 }, () => expect.stringMatching(/^buildx imagetools inspect --raw .+@sha256:[a-f0-9]{64}$/))
    )
  })

  it("reports a real registry failure under the run verb and stops before the next tag", async () => {
    const unavailableRegistry = `smthrs-approval-outage-${randomUUID()}`
    try {
      await docker("run", "--detach", "--name", unavailableRegistry, "--publish", "127.0.0.1::5000", "registry:2.8.3")
      const address = await registryAddress(unavailableRegistry)
      await readyRegistry(address)
      const workspace = await fixture(["one", "two", "three"], { registry: address })
      const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
        environment: workspace.environment
      })
      let checks = 0
      const result = await serve(workspace.root, ["run", "//:push"], {
        environment: workspace.environment,
        approvals: {
          granted: async (request) => {
            if (++checks === 2) await docker("stop", "--time", "0", unavailableRegistry)
            return request.digest === revision.digest
          }
        }
      })
      expect(result.exitCode).toBe(1)
      expect(pushes(await workspace.calls())).toEqual([`push ${address}/fixture:one`])
    } finally {
      await removeRegistry(unavailableRegistry)
    }
  })

  it("does not carry an approval over to an edited declaration or input", async () => {
    const workspace = await fixture(["one"])
    const memory = memoryStore()
    const first = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    memory.approve(first.label, first.digest)
    await workspace.setTags(["one", "two"])
    const retagged = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    await Fs.writeFile(Path.join(workspace.root, "hello.txt"), "edited\n")
    const rebuilt = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })

    expect(new Set([first.digest, retagged.digest, rebuilt.digest]).size).toBe(3)
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("is not approved")
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("binds the approval to the invocation's payload inputs", async () => {
    const workspace = await fixture(["one"])
    const memory = memoryStore()
    const plain = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    const withInput = await approvalRevision("//:push", { workspace: workspace.root, input: ["channel=beta"] }, {
      environment: workspace.environment
    })
    memory.approve(plain.label, plain.digest)
    const result = await serve(workspace.root, ["//:push", "--input", "channel=beta"], {
      environment: workspace.environment,
      approvals: memory.store
    })

    expect(withInput.digest).not.toBe(plain.digest)
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("is not approved")
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("fails closed when the store cannot answer", async () => {
    const workspace = await fixture(["one"])
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: { granted: () => Promise.reject(new Error("approval store unreadable")) }
    })

    expect(result.exitCode).toBe(1)
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("keeps the secret boundary after approval: a declared secret with no value pushes nothing", async () => {
    const workspace = await fixture(["one", "two"], {
      secrets: "[S.HttpSecret(S.Secret(\"FIXTURE_REGISTRY_TOKEN\"), [\"https://127.0.0.1:5999\"])]"
    })
    const memory = memoryStore()
    const environment = { ...workspace.environment, FIXTURE_REGISTRY_TOKEN: undefined }
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, { environment })
    memory.approve(revision.label, revision.digest)
    const result = await serve(workspace.root, ["//:push"], { environment, approvals: memory.store })

    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("FIXTURE_REGISTRY_TOKEN")
    expect(pushes(await workspace.calls())).toEqual([])
  })

  const vcs = (root: string, args: ReadonlyArray<string>) => {
    const result = spawnSync("jj", [
      "--config",
      "user.name=fixture",
      "--config",
      "user.email=fixture@example.invalid",
      ...args
    ], {
      cwd: root,
      encoding: "utf8"
    })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  const commit = (root: string, message: string) => {
    vcs(root, ["describe", "-m", message])
    vcs(root, ["new"])
    return vcs(root, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
  }

  it("pins a stamped tag into the approved revision and pushes the approved value", async () => {
    const workspace = await fixture("[S.Stamp.commit]")
    vcs(workspace.root, ["git", "init", "--colocate"])
    const approvedHead = commit(workspace.root, "first")
    const memory = memoryStore()
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    memory.approve(revision.label, revision.digest)
    const planned = await serve(workspace.root, ["//:push", "--plan"], {
      environment: workspace.environment,
      approvals: memory.store
    })
    expect(planned.output).toContain(`${registry}/fixture:${approvedHead}`)
    expect(planned.output).not.toContain("{smthrs:stamp:")

    // Moving HEAD after the grant is a new revision, refused before any effect.
    commit(workspace.root, "second")
    const moved = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })
    expect(moved.exitCode).toBe(1)
    expect(`${moved.output}${moved.logs}`).toContain("is not approved")
    expect(pushes(await workspace.calls())).toEqual([])
    expect(
      (await approvalRevision("//:push", { workspace: workspace.root }, { environment: workspace.environment }))
        .digest
    ).not.toBe(revision.digest)

    vcs(workspace.root, ["new", approvedHead])
    const ran = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })
    expect(ran.exitCode, `${ran.output}${ran.logs}`).toBe(0)
    expect(pushes(await workspace.calls())).toEqual([`push ${registry}/fixture:${approvedHead}`])
    const image = await workspace.image()
    expect(await workspace.calls()).toContainEqual(
      expect.stringMatching(new RegExp(`^tag (${image.config}|${image.manifest}) ${registry}/fixture:${approvedHead}$`))
    )
  })

  for (const tags of [["one", "two"], "[S.Stamp.commit, \"fixed\"]"] as const) {
    it(`grants exactly the revision the run checks at planning and again before pushing ${JSON.stringify(tags)}`, async () => {
      const workspace = await fixture(typeof tags === "string" ? tags : [...tags])
      vcs(workspace.root, ["git", "init", "--colocate"])
      commit(workspace.root, "first")
      const memory = memoryStore()
      const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
        environment: workspace.environment
      })
      const again = await approvalRevision("//:push", { workspace: workspace.root }, {
        environment: workspace.environment
      })
      memory.approve(revision.label, revision.digest)
      const result = await serve(workspace.root, ["//:push"], {
        environment: workspace.environment,
        approvals: memory.store
      })

      expect(again).toEqual(revision)
      expect(result.exitCode, `${result.output}${result.logs}`).toBe(0)
      // Planning asks once and the pre-push recheck asks again, both for the granted revision.
      expect(memory.asked).toEqual([revision, revision])
      expect(pushes(await workspace.calls())).toHaveLength(2)
    })
  }

  it("refuses a buildTime stamp, which no approval can name", async () => {
    const workspace = await fixture("[S.Stamp.buildTime]")
    const memory = memoryStore()
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    memory.approve(revision.label, revision.digest)
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store
    })
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("stamps buildTime")
    expect(await workspace.calls()).not.toContainEqual(expect.stringMatching(/^(push|buildx build)/))
  })

  it("checks the revision again before the push: an input edited while the build ran refuses it", async () => {
    const workspace = await fixture(["one"])
    const memory = memoryStore()
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    memory.approve(revision.label, revision.digest)
    const result = await serve(workspace.root, ["//:push"], {
      environment: workspace.environment,
      approvals: memory.store,
      onLog: (text) => {
        if (text.includes("//:image  ran")) writeFileSync(Path.join(workspace.root, "hello.txt"), "edited-during-build")
      }
    })
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain(
      `changed after planning: approved revision ${revision.digest.slice(0, 12)}`
    )
    expect(await workspace.calls()).toContainEqual(expect.stringMatching(/^buildx build/))
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("checks the grant again before the push: a grant revoked while the build ran refuses it", async () => {
    const workspace = await fixture(["one"])
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    const asked: Array<string> = []
    const store: PackageExec.TargetApprovals = {
      granted: async (request) => {
        asked.push(request.digest)
        return asked.length === 1 && request.digest === revision.digest
      }
    }
    const result = await serve(workspace.root, ["//:push"], { environment: workspace.environment, approvals: store })
    expect(asked).toEqual([revision.digest, revision.digest])
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("is not approved")
    expect(pushes(await workspace.calls())).toEqual([])
  })

  it("hands the parent's store to a watch cycle's fresh build CLI", async () => {
    const workspace = await fixture(["one"])
    const memory = memoryStore()
    const revision = await approvalRevision("//:push", { workspace: workspace.root }, {
      environment: workspace.environment
    })
    const refused = await serve(workspace.root, ["watch", "run", "//:push", "--once"], {
      environment: workspace.environment,
      approvals: memory.store
    })
    expect(refused.exitCode).toBe(1)
    expect(pushes(await workspace.calls())).toEqual([])

    memory.approve(revision.label, revision.digest)
    const ran = await serve(workspace.root, ["watch", "run", "//:push", "--once"], {
      environment: workspace.environment,
      approvals: memory.store
    })
    expect(ran.exitCode, `${ran.output}${ran.logs}`).toBe(0)
    expect(pushes(await workspace.calls())).toEqual([`push ${registry}/fixture:one`])
    // The child asked this process's store, for this exact revision.
    expect(memory.asked).toContainEqual(revision)
  })

  it("refuses to name a revision for a target that needs no approval", async () => {
    const workspace = await fixture(["one"])
    await expect(approvalRevision("//:image", { workspace: workspace.root }, { environment: workspace.environment }))
      .rejects.toThrow("//:image does not declare approval: \"required\"")
  })
})
