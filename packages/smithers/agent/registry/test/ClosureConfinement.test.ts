/**
 * A confined source's closure stays inside its root, and no closure or config
 * file is read past its byte ceiling (#4731).
 *
 * Real files and a real file system throughout. The observing layer forwards
 * every call and records which paths the walk touched, so "never read" is an
 * observation rather than an inference from the result.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Digest from "@smthrs/core/Digest"
import { ByteSize, Effect, FileSystem, Layer, Path, PlatformError, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as ModuleClosure from "../src/internal/ModuleClosure.ts"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(platform), Effect.scoped) as Effect.Effect<A, E>)

const flowSource = (name: string, imports: ReadonlyArray<string>) =>
  `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
${imports.map((specifier) => `import ${JSON.stringify(specifier)}`).join("\n")}
export default Flow.make(${JSON.stringify(name)}, { description: "Confinement", payload: {}, success: Schema.String,
  body: () => Node.succeed("done") })`

/** Every path a walk asked the host about, and how many bytes each stream could read. */
const observed = (fs: FileSystem.FileSystem) => {
  const touched: Array<string> = []
  const whole: Array<string> = []
  const streams: Array<{ readonly path: string; readonly bytesToRead: unknown }> = []
  const seen = <A>(path: string, value: A): A => {
    touched.push(path)
    return value
  }
  return {
    touched,
    whole,
    streams,
    fs: FileSystem.FileSystem.of({
      ...fs,
      stat: (path) => seen(path, fs.stat(path)),
      realPath: (path) => seen(path, fs.realPath(path)),
      readFile: (path) => {
        whole.push(path)
        return seen(path, fs.readFile(path))
      },
      stream: (path, options) => {
        streams.push({ path, bytesToRead: options?.bytesToRead })
        return seen(path, fs.stream(path, options))
      }
    })
  }
}

/** A host directory holding a secret beside a pack whose flows try to reach it. */
const pack = (flows: Readonly<Record<string, ReadonlyArray<string>>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "smithers-closure-confinement-" }))
    const secret = path.join(host, "host-secret.ts")
    const root = path.join(host, "pack")
    yield* fs.writeFileString(secret, "export const secret = \"HOST_SECRET\"")
    for (const [name, imports] of Object.entries(flows)) {
      yield* fs.makeDirectory(path.join(root, "flows", name), { recursive: true })
      yield* fs.writeFileString(path.join(root, "flows", name, "flow.ts"), flowSource(name, imports))
    }
    yield* fs.makeDirectory(path.join(root, "lib"), { recursive: true })
    yield* fs.writeFileString(path.join(root, "lib", "inside.ts"), "export const inside = true")
    const scan = (using: FileSystem.FileSystem) =>
      Discovery.make(using, path).scan({
        source: "pack:acme",
        root: path.join(root, "flows"),
        confinementRoot: root,
        naming: "path"
      })
    return { fs, path, host, root, secret, scan }
  })

const importsOf = (scan: Descriptor.SourceScan, name: string) => {
  const body = scan.entries.find((entry) => entry.name === name)!.body
  return body._tag === "Module" ? body.imports ?? [] : []
}

describe("closure confinement", () => {
  it("records a relative import that leaves the pack root as unpinnable without touching the host file", async () => {
    await run(Effect.gen(function*() {
      const { fs, host, scan, secret } = yield* pack({ evil: ["../../../host-secret.ts", "../../lib/inside.ts"] })
      const watch = observed(fs)
      const imports = importsOf(yield* scan(watch.fs), "evil")
      expect(imports).toEqual([
        {
          path: "../../lib/inside.ts",
          contentDigest: Digest.digest(new TextEncoder().encode("export const inside = true"))
        },
        { path: "the entry imports \"../../../host-secret.ts\", which resolves outside the source's confinement root" }
      ])
      expect(JSON.stringify(imports)).not.toContain(Digest.digest(yield* fs.readFile(secret)))
      // Neither the secret nor any suffix or index candidate beside it was probed.
      expect(watch.touched.filter((path) => path.startsWith(`${host}/host-secret`))).toEqual([])
    }))
  })

  it("refuses to load the flow, and reads and writes nothing outside the pack, when its closure left the root", async () => {
    await run(Effect.gen(function*() {
      const { fs, host, scan } = yield* pack({ evil: ["../../../host-secret.ts"] })
      const descriptor = (yield* scan(fs)).entries[0]!
      const before = yield* fs.readDirectory(host)
      const watch = observed(fs)
      let loads = 0
      const failure = yield* Executable.fromDescriptor(descriptor, {
        delegates: [],
        load: () => {
          loads++
          return Effect.succeed({})
        }
      }).pipe(Effect.provideService(FileSystem.FileSystem, watch.fs), Effect.flip)
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toContain("runs code this host cannot pin")
      expect(failure.message).toContain("resolves outside the source's confinement root")
      expect(loads).toBe(0)
      expect(watch.touched.filter((path) => path.startsWith(`${host}/host-secret`))).toEqual([])
      expect(yield* fs.readDirectory(host)).toEqual(before)
    }))
  })

  it("refuses a pinned helper that computes a load after discovery measured it", async () => {
    await run(Effect.gen(function*() {
      const { fs, path, root, scan } = yield* pack({ drift: ["../../lib/inside.ts"] })
      const descriptor = (yield* scan(fs)).entries[0]!
      yield* fs.writeFileString(path.join(root, "lib", "inside.ts"), "export const inside = await import(name)")
      let loads = 0
      const failure = yield* Executable.fromDescriptor(descriptor, {
        delegates: [],
        load: () => {
          loads++
          return Effect.succeed({})
        }
      }).pipe(Effect.flip)
      expect(failure.message).toContain(
        "runs code this host cannot pin: \"../../lib/inside.ts\" computes the target of 1 import() or require() call(s)"
      )
      expect(loads).toBe(0)
    }))
  })

  it("refuses a symbolic link inside the pack that names a host file, and never streams it", async () => {
    await run(Effect.gen(function*() {
      const { fs, path, root, scan, secret } = yield* pack({ linked: ["./link.ts"], sibling: ["../linked/link.ts"] })
      yield* fs.symlink(secret, path.join(root, "flows", "linked", "link.ts"))
      const watch = observed(fs)
      const scanned = yield* scan(watch.fs)
      expect(importsOf(scanned, "linked")).toEqual([
        { path: "the entry imports \"./link.ts\", which resolves outside the source's confinement root" }
      ])
      // The second flow reaches the same link; the scan answers from what it learned for the first.
      expect(importsOf(scanned, "sibling")).toEqual([
        { path: "the entry imports \"../linked/link.ts\", which resolves outside the source's confinement root" }
      ])
      expect(watch.streams.filter((stream) => stream.path.endsWith("link.ts"))).toEqual([])
      expect(watch.touched.filter((touched) => touched === secret)).toEqual([])
    }))
  })

  it("refuses a closure file whose real path the host cannot resolve", async () => {
    await run(Effect.gen(function*() {
      const { fs, path, root, scan } = yield* pack({ plain: ["../../lib/inside.ts"] })
      const inside = path.join(root, "lib", "inside.ts")
      // The host answers stat for the helper and then refuses to resolve it: a deterministic stand-in for a link
      // retargeted between the two calls.
      const unresolved = FileSystem.FileSystem.of({
        ...fs,
        realPath: (target) =>
          target === inside
            ? Effect.fail(PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "realPath",
              pathOrDescriptor: target,
              description: "Injected real path refusal"
            }))
            : fs.realPath(target)
      })
      expect(importsOf(yield* scan(unresolved), "plain")).toEqual([
        { path: "the entry imports \"../../lib/inside.ts\", which resolves outside the source's confinement root" }
      ])
    }))
  })
})

describe("closure read ceilings", () => {
  it("stops reading a closure file one byte past what the closure has left", async () => {
    await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-closure-ceiling-" })
      const entry = path.join(root, "flow.ts")
      yield* fs.writeFileString(entry, "import \"./small.ts\"\nimport \"./large.ts\"")
      yield* fs.writeFileString(path.join(root, "small.ts"), "export {}\n")
      yield* fs.writeFile(path.join(root, "large.ts"), new Uint8Array(1024 * 1024).fill(32))
      const watch = observed(fs)
      const imports = yield* ModuleClosure.collect(
        watch.fs,
        path,
        entry,
        yield* fs.readFileString(entry),
        ModuleClosure.cache(),
        { files: 8, bytes: 64 }
      )
      expect(imports).toEqual([
        { path: "small.ts", contentDigest: Digest.digest(new TextEncoder().encode("export {}\n")) },
        { path: "the closure totals more than 64 bytes" }
      ])
      // 64 bytes of budget, 10 spent on small.ts: large.ts may yield 55 bytes and no more.
      expect(watch.streams).toEqual([
        { path: path.join(root, "small.ts"), bytesToRead: 65 },
        { path: path.join(root, "large.ts"), bytesToRead: 55 }
      ])
    }))
  })

  it("reports a bare specifier an oversized config could map as unpinnable instead of parsing the config", async () => {
    await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-closure-config-" })
      const entry = path.join(root, "flows", "flow.ts")
      const config = path.join(root, "flows", "tsconfig.json")
      yield* fs.makeDirectory(path.join(root, "flows"))
      yield* fs.writeFileString(entry, "import \"mapped\"")
      yield* fs.writeFileString(path.join(root, "flows", "mapped.ts"), "export {}")
      // A valid config that maps the specifier, padded past the ceiling.
      const mapping = JSON.stringify({ compilerOptions: { paths: { mapped: ["./mapped.ts"] } } })
      yield* fs.writeFileString(config, mapping + " ".repeat(ModuleClosure.configByteLimit + 1 - mapping.length))
      const watch = observed(fs)
      const memo = ModuleClosure.cache()
      const refusal = {
        path:
          `the entry imports "mapped", which "tsconfig.json" may map: that config is larger than ${ModuleClosure.configByteLimit} bytes`
      }
      const source = yield* fs.readFileString(entry)
      expect(yield* ModuleClosure.collect(watch.fs, path, entry, source, memo)).toEqual([refusal])
      expect(watch.streams.filter((stream) => stream.path === config)).toEqual([
        { path: config, bytesToRead: ModuleClosure.configByteLimit + 1 }
      ])
      // A sibling entry in the same scan gets the same refusal from the cached verdict.
      const sibling = path.join(root, "flows", "nested", "flow.ts")
      yield* fs.makeDirectory(path.dirname(sibling))
      yield* fs.writeFileString(sibling, "import \"mapped\"")
      expect(yield* ModuleClosure.collect(watch.fs, path, sibling, "import \"mapped\"", memo)).toEqual([
        {
          path:
            `the entry imports "mapped", which "../tsconfig.json" may map: that config is larger than ${ModuleClosure.configByteLimit} bytes`
        }
      ])
      expect(watch.streams.filter((stream) => stream.path === config)).toHaveLength(1)
      // The same mapping under the ceiling is followed and pinned.
      yield* fs.writeFileString(config, mapping)
      expect(yield* ModuleClosure.collect(fs, path, entry, source)).toEqual([
        { path: "mapped.ts", contentDigest: Digest.digest(new TextEncoder().encode("export {}")) }
      ])
    }))
  })

  /** The kernel's confined host: one atomic request per operation, so no `stream` and no `open`. */
  const atomicOnly = (fs: FileSystem.FileSystem) => {
    const refused = (method: string, path: string) =>
      PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        description: "Not expressible as one atomic request"
      })
    return FileSystem.FileSystem.of({
      ...fs,
      open: (path) => Effect.fail(refused("open", path)),
      stream: (path) => Stream.fail(refused("stream", path))
    })
  }

  it("re-measures a closure for the loader on a host that offers only atomic whole-file reads", async () => {
    await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-closure-atomic-" })
      const entry = path.join(root, "flow.ts")
      yield* fs.writeFileString(entry, "import \"./helper.ts\"\nimport \"mapped\"")
      yield* fs.writeFileString(path.join(root, "helper.ts"), "export {}")
      yield* fs.writeFileString(path.join(root, "mapped.ts"), "export {}\n")
      yield* fs.writeFileString(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { paths: { mapped: ["./mapped.ts"] } } })
      )
      const measured = yield* ModuleClosure.snapshot(atomicOnly(fs), path, entry, yield* fs.readFile(entry))
      expect(measured.imports).toEqual([
        { path: "helper.ts", contentDigest: Digest.digest(new TextEncoder().encode("export {}")) },
        { path: "mapped.ts", contentDigest: Digest.digest(new TextEncoder().encode("export {}\n")) }
      ])
    }))
  })

  it.each(["reported", "misreported"] as const)(
    "refuses a %s oversized module when the loader re-measures a closure",
    async (mode) => {
      await run(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-closure-whole-" })
        const entry = path.join(root, "flow.ts")
        const large = path.join(root, "large.ts")
        yield* fs.writeFileString(entry, "import \"./large.ts\"")
        yield* fs.writeFile(large, new Uint8Array(65).fill(32))
        // A host that reports the file as empty: the bytes returned still decide.
        const lying = FileSystem.FileSystem.of({
          ...fs,
          stat: (target) =>
            Effect.map(fs.stat(target), (info) => target === large ? { ...info, size: ByteSize.bytes(0) } : info)
        })
        const watch = observed(atomicOnly(mode === "reported" ? fs : lying))
        const measured = yield* ModuleClosure.snapshot(watch.fs, path, entry, yield* fs.readFile(entry), {
          files: 8,
          bytes: 64
        })
        expect(measured.imports).toEqual([{ path: "the closure totals more than 64 bytes" }])
        // A size the host reported past the ceiling is never read; a misreported one is read and then refused.
        expect(watch.whole.filter((read) => read === large)).toHaveLength(mode === "reported" ? 0 : 1)
      }))
    }
  )

  it("reports an oversized config to the loader as it does to the scan", async () => {
    await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-closure-whole-config-" })
      const entry = path.join(root, "flow.ts")
      yield* fs.writeFileString(entry, "import \"mapped\"")
      yield* fs.writeFileString(path.join(root, "tsconfig.json"), " ".repeat(ModuleClosure.configByteLimit + 1))
      const measured = yield* ModuleClosure.snapshot(atomicOnly(fs), path, entry, yield* fs.readFile(entry))
      expect(measured.imports).toEqual([{
        path:
          `the entry imports "mapped", which "tsconfig.json" may map: that config is larger than ${ModuleClosure.configByteLimit} bytes`
      }])
    }))
  })
})
