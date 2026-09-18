import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as Tsconfig from "../src/Tsconfig.ts"

const Holder = Target.make("DeclaredInputBoundary", {
  attrs: Schema.Struct({ input: Input.Declared }),
  kinds: [],
  implementation: () => Target.notImplemented("DeclaredInputBoundary")
})

describe("declared inputs are recognized without running author code", () => {
  it.each([
    ["File", "path", "README.md"],
    ["Glob", "pattern", "src/**"],
    ["GitDiff", "base", "HEAD"],
    ["PnpmWorkspace", "path", "pnpm-workspace.yaml"]
  ])("rejects a forged %s member without invoking its getter", (tag, field, value) => {
    let reads = 0
    const input = Object.defineProperty({ _tag: tag, exclude: [] }, field!, {
      enumerable: true,
      get: () => {
        reads++
        throw new Error(`getter ran: ${value}`)
      }
    })
    expect(() => Input.isDeclared(input)).not.toThrow()
    expect(Input.isDeclared(input)).toBe(false)
    expect(() => Holder({ input } as never)).toThrow(/accessor/)
    expect(reads).toBe(0)
  })

  it("rejects an accessor discriminator without reading it", () => {
    let reads = 0
    const input = {
      get _tag() {
        reads++
        throw new Error("tag getter ran")
      },
      path: "README.md"
    }
    expect(Input.isDeclared(input)).toBe(false)
    expect(() => Holder({ input } as never)).toThrow(/accessor/)
    expect(reads).toBe(0)
  })

  it.each(["exclude", "paths", "added"])("rejects an accessor in the %s array", (field) => {
    let reads = 0
    const values = Object.defineProperty(["src/**"], "0", {
      enumerable: true,
      get: () => {
        reads++
        throw new Error("array getter ran")
      }
    })
    const input = field === "exclude"
      ? { _tag: "Glob", pattern: "src/**", exclude: values }
      : { _tag: "GitDiff", base: "HEAD", [field]: values }
    expect(Input.isDeclared(input)).toBe(false)
    expect(() => Holder({ input } as never)).toThrow(/accessor/)
    expect(reads).toBe(0)
  })

  it("rejects proxies at both the record and string-array boundary without traps", () => {
    const traps: Array<string> = []
    const hostile = <A extends object>(value: A): A =>
      new Proxy(value, {
        get: () => {
          traps.push("get")
          throw new Error("proxy get")
        },
        ownKeys: () => {
          traps.push("ownKeys")
          throw new Error("proxy ownKeys")
        },
        getPrototypeOf: () => {
          traps.push("getPrototypeOf")
          throw new Error("proxy prototype")
        }
      })
    for (
      const input of [hostile(Input.file("README.md")), {
        _tag: "Glob",
        pattern: "src/**",
        exclude: hostile(["src/private/**"])
      }]
    ) {
      expect(Input.isDeclared(input)).toBe(false)
      expect(() => Holder({ input } as never)).toThrow(/Proxy/)
    }
    expect(traps).toEqual([])
  })

  it("retains genuine input handles and rejects malformed records", () => {
    for (
      const input of [
        Input.file("README.md"),
        Input.glob("src/**", { exclude: ["src/private/**"] }),
        Input.gitDiff({ base: "HEAD", paths: ["src/**"], added: ["src/new/**"], addedLines: "changed" }),
        Input.pnpmWorkspace("pnpm-workspace.yaml")
      ]
    ) {
      expect(Input.isDeclared(input)).toBe(true)
      expect(Target.metadata(Holder({ input })).inputs).toEqual([input])
    }
    for (
      const input of [null, 1, "File", {}, { _tag: "Other" }, { _tag: "File" }, { _tag: "File", path: "" }, {
        _tag: "Glob",
        pattern: "src/**",
        exclude: [4]
      }]
    ) {
      expect(Input.isDeclared(input)).toBe(false)
    }
  })

  it("refuses a handle carried on a class prototype rather than a plain object", () => {
    // Recognition reads own descriptors only, so a class instance could smuggle
    // behaviour onto its prototype and still present the right own fields. An
    // input declaration is data, and data has the object prototype or none.
    class FileHandle {
      readonly _tag = "File"
      readonly path = "README.md"
    }
    expect(Input.isDeclared(new FileHandle())).toBe(false)
    expect(Input.isDeclared(Object.assign(Object.create({ leak: true }), Input.file("README.md")))).toBe(false)
  })

  it("preserves richer input types when used as a filter predicate", () => {
    const input = { ...Input.file("README.md"), hint: "documentation" }
    const values: Array<typeof input | undefined> = [input, undefined]
    const retained: Array<typeof input> = values.filter(Input.isDeclared)
    expect(retained).toEqual([input])
    expect(retained[0]?.hint).toBe("documentation")
  })

  it.each(["include", "exclude"])("snapshots Tsconfig %s before pattern normalization", (field) => {
    let reads = 0
    const input = {
      _tag: "File",
      get path() {
        reads++
        throw new Error("normalizer getter ran")
      }
    }
    expect(() => Tsconfig.Tsconfig({ [field]: [input] } as never)).toThrow(/accessor/)
    expect(reads).toBe(0)
  })
})

describe("captured declared inputs cannot change after construction", () => {
  it("copies and freezes real Shell and Filegroup inputs without freezing caller values", () => {
    const script = Input.file("before-script.ts") as { _tag: "File"; path: string }
    const file = Input.file("before.ts") as { _tag: "File"; path: string }
    const glob = Input.glob("src/**", { exclude: ["src/private/**"] }) as {
      _tag: "Glob"
      pattern: string
      exclude: Array<string>
    }
    const shell = Shell.Run({ script })
    const group = Filegroup.Filegroup({ srcs: [file, glob] })
    const shellAttrs = Target.metadata(shell).attrs as { script: typeof script }
    const groupAttrs = Target.metadata(group).attrs as { srcs: [typeof file, typeof glob] }
    const before = JSON.stringify({
      shell: shellAttrs,
      group: groupAttrs,
      inputs: Target.metadata(group).inputs,
      argv: Shell.execPayload(shellAttrs).argv
    })

    script.path = "caller-script.ts"
    file.path = "caller.ts"
    glob.pattern = "caller/**"
    glob.exclude.push("caller/private/**")
    expect(Object.isFrozen(script)).toBe(false)
    expect(Object.isFrozen(glob.exclude)).toBe(false)
    expect(() => {
      shellAttrs.script.path = "metadata-script.ts"
    }).toThrow(TypeError)
    expect(() => {
      groupAttrs.srcs[0].path = "metadata.ts"
    }).toThrow(TypeError)
    expect(() => {
      groupAttrs.srcs[1].pattern = "metadata/**"
    }).toThrow(TypeError)
    expect(() => {
      groupAttrs.srcs[1].exclude.push("metadata/private/**")
    }).toThrow(TypeError)
    expect(JSON.stringify({
      shell: shellAttrs,
      group: groupAttrs,
      inputs: Target.metadata(group).inputs,
      argv: Shell.execPayload(shellAttrs).argv
    })).toBe(before)
  })

  it("owns declared records even through Unknown while preserving dependency handles", () => {
    const UnknownHolder = Target.make("UnknownInputBoundary", {
      attrs: Schema.Struct({ input: Schema.Unknown, dependency: Target.Target }),
      kinds: [],
      implementation: () => Target.notImplemented("UnknownInputBoundary")
    })
    const file = Input.file("before.ts") as { _tag: "File"; path: string }
    const dependency = Holder({ input: Input.file("dependency.ts") })
    const target = UnknownHolder({ input: file, dependency })
    const metadata = Target.metadata(target)
    const attrs = metadata.attrs as { input: typeof file; dependency: Target.AnyTarget }
    file.path = "caller.ts"
    expect(attrs.input.path).toBe("before.ts")
    expect(Object.isFrozen(file)).toBe(false)
    expect(() => {
      attrs.input.path = "metadata.ts"
    }).toThrow(TypeError)
    expect(attrs.dependency).toBe(dependency)
    expect(metadata.dependencies).toEqual([dependency])
    expect(metadata.inputs).toEqual([{ _tag: "File", path: "before.ts" }])
  })
})
