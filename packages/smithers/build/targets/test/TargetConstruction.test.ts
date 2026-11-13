/**
 * The construction boundary: what a declaration may contain, when the author's
 * input is read, and what stays mutable afterwards.
 */
import { describe, expect, it } from "vitest"
import { Smithers } from "../src/index.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"

const docsParity = () =>
  Smithers.DocsParity({ readme: Smithers.file("README.md"), deps: [], cwd: "packages/smithers/build/targets" })

describe("author input is read once, as data", () => {
  it("never invokes an accessor on the author's attrs", () => {
    let reads = 0
    const attrs = {
      deps: [],
      cwd: "packages/smithers/build/targets",
      get readme() {
        reads += 1
        return Smithers.file("README.md")
      }
    }
    expect(() => Smithers.DocsParity(attrs as never)).toThrow(/enumerable data properties/)
    expect(reads).toBe(0)
  })

  it("rejects a Proxy before the schema sees it", () => {
    const traps: Array<string> = []
    const attrs = new Proxy({ readme: Smithers.file("README.md"), deps: [], cwd: "." }, {
      get: (target, key, receiver) => {
        traps.push(String(key))
        return Reflect.get(target, key, receiver)
      },
      ownKeys: (target) => {
        traps.push("ownKeys")
        return Reflect.ownKeys(target)
      }
    })
    expect(() => Smithers.DocsParity(attrs as never)).toThrow(/must not contain a Proxy/)
    expect(traps).toEqual([])
  })

  it("rejects a nested accessor and names the offending key", () => {
    const inner: Record<string, unknown> = {}
    Object.defineProperty(inner, "path", { enumerable: true, get: () => "README.md" })
    expect(() => Smithers.DocsParity({ readme: inner, deps: [], cwd: "." } as never))
      .toThrow(/"path" is an accessor/)
  })

  it("does not read the author's object again after construction", () => {
    const attrs = {
      readme: Smithers.file("README.md"),
      deps: [] as Array<never>,
      cwd: "packages/smithers/build/targets"
    }
    const target = Smithers.DocsParity(attrs)
    attrs.cwd = "HACKED"
    expect((Target.metadata(target).attrs as { readonly cwd: string }).cwd).toBe("packages/smithers/build/targets")
  })
})

describe("validated metadata is immutable", () => {
  it("freezes the metadata record itself", () => {
    const target = docsParity()
    expect(Object.isFrozen(Target.metadata(target))).toBe(true)
  })

  it("freezes the decoded attrs", () => {
    const target = docsParity()
    const attrs = Target.metadata(target).attrs as Record<string, unknown>
    expect(Object.isFrozen(attrs)).toBe(true)
    expect(() => {
      attrs["cwd"] = "HACKED"
    }).toThrow(TypeError)
    expect(attrs["cwd"]).toBe("packages/smithers/build/targets")
  })

  it("freezes every collection metadata exposes", () => {
    const sources = Smithers.glob("src/**/*.ts")
    const target = Smithers.Filegroup({ srcs: [sources], cwd: "packages/smithers/build/targets" })
    const view = Target.metadata(target)
    expect(() => (view.inputs as Array<Input.Declared>).push(sources)).toThrow(TypeError)
    expect(view.inputs.length).toBe(1)
    expect(() => (view.dependencies as Array<Target.AnyTarget>).push(target)).toThrow(TypeError)
    expect(() => (view.kinds as Array<Target.Kind>).push("build")).toThrow(TypeError)
  })

  it("freezes the declared output tree", () => {
    const target = Smithers.Fetch({
      url: "https://example.invalid/source",
      sha256: "0".repeat(64),
      out: "dist"
    })
    const outputs = Target.metadata(target).outputs
    expect(outputs).toBeDefined()
    expect(Object.isFrozen(outputs)).toBe(true)
    expect(Object.isFrozen(outputs!.paths)).toBe(true)
    expect(() => (outputs!.paths as Array<string>).push("changed")).toThrow(TypeError)
    expect(Reflect.set(outputs!, "paths", [])).toBe(false)
    expect(outputs!.paths).toEqual(["dist"])
  })

  it("freezes each kind view", () => {
    const target = docsParity()
    for (const kind of Target.metadata(target).kinds) {
      const view = Target.metadata(target).forKind(kind)
      expect(Object.isFrozen(view)).toBe(true)
      expect(Object.isFrozen(view.inputs)).toBe(true)
      expect(Object.isFrozen(view.dependencies)).toBe(true)
    }
  })

  it("keeps identity and every projection unchanged after an attempted mutation", () => {
    const target = docsParity()
    const before = Target.metadata(target)
    const digest = before.implementationDigest
    expect(() => (before.inputs as Array<Input.Declared>).push(Smithers.file("README.md"))).toThrow(TypeError)
    expect(Target.metadata(target).implementationDigest).toBe(digest)
    expect(Target.metadata(target).inputs.length).toBe(before.inputs.length)
  })

  const schemaIdentity = () =>
    Target.metadata(docsParity()).schemaIdentity as {
      attrs: unknown
      success: unknown
      error: unknown
    }

  it("freezes the schema identity and the documents inside it", () => {
    const identity = schemaIdentity()
    expect(Object.isFrozen(identity)).toBe(true)
    expect(Object.isFrozen(identity.attrs)).toBe(true)
    expect(Object.isFrozen(identity.success)).toBe(true)
    expect(Object.isFrozen(identity.error)).toBe(true)
  })

  it("refuses to rewrite the schema identity the planner keys on", () => {
    const identity = schemaIdentity()
    const before = identity.attrs
    expect(() => {
      identity.attrs = { mutated: true }
    }).toThrow(TypeError)
    expect(schemaIdentity().attrs).toBe(before)
  })
})

describe("the pre-validation reads the snapshot, not the author's object", () => {
  const clippy = () => ({ workspace: true, data: [] as Array<never> })

  it("never invokes an accessor on a guarded rule's attrs", () => {
    let reads = 0
    const attrs = {
      data: [],
      get workspace() {
        reads += 1
        return true
      }
    }
    expect(() => Smithers.Cargo.Build(attrs as never)).toThrow(/enumerable data properties/)
    expect(reads).toBe(0)
  })

  it("springs no Proxy trap on a guarded rule before the refusal", () => {
    const traps: Array<string> = []
    const attrs = new Proxy(clippy(), {
      get: (target, key, receiver) => {
        traps.push(String(key))
        return Reflect.get(target, key, receiver)
      },
      ownKeys: (target) => {
        traps.push("ownKeys")
        return Reflect.ownKeys(target)
      }
    })
    expect(() => Smithers.Cargo.Build(attrs as never)).toThrow(/must not contain a Proxy/)
    expect(traps).toEqual([])
  })

  it("names the BUILD site when a guarded rule is refused before its schema", () => {
    expect(() => Smithers.Cargo.Build({ workspace: {} as never } as never))
      .toThrow(/Cargo\.Build declaration is invalid/)
  })

  it("still refuses the guard's own rule after the snapshot", () => {
    expect(() => Smithers.Cargo.Build({ data: [] } as never))
      .toThrow(/Cargo\.Build requires exactly one of/)
  })
})

describe("only plain data, targets, and declared inputs reach the schema", () => {
  it("refuses a class instance and names its constructor", () => {
    class BuildArgs {
      get version(): string {
        return "1"
      }
    }
    expect(() =>
      Smithers.Docker.Build({
        dockerfile: Smithers.file("Dockerfile"),
        context: ".",
        buildArgs: new BuildArgs() as never
      })
    ).toThrow(/BuildArgs/)
  })

  it("never invokes the accessor of a refused exotic value", () => {
    let reads = 0
    class BuildArgs {
      get version(): string {
        reads += 1
        return "1"
      }
    }
    expect(() =>
      Smithers.Docker.Build({
        dockerfile: Smithers.file("Dockerfile"),
        context: ".",
        buildArgs: new BuildArgs() as never
      })
    ).toThrow(/plain data/)
    expect(reads).toBe(0)
  })

  it("refuses a null-constructor exotic without naming one", () => {
    const exotic = Object.create(Object.create(null)) as Record<string, unknown>
    exotic["version"] = "1"
    expect(() =>
      Smithers.Docker.Build({
        dockerfile: Smithers.file("Dockerfile"),
        context: ".",
        buildArgs: exotic as never
      })
    ).toThrow(/an object with a prototype of its own/)
  })

  it("keeps a plain table and a declared input working", () => {
    const target = Smithers.Docker.Build({
      dockerfile: Smithers.file("Dockerfile"),
      context: ".",
      buildArgs: { version: "1" }
    })
    expect(Target.metadata(target).target).toBe("Docker.Build")
  })
})

describe("nested target handles stay opaque", () => {
  it("keeps a dependency target by reference rather than copying it", () => {
    const dependency = Smithers.Filegroup({
      srcs: [Smithers.glob("src/**/*.ts")],
      cwd: "packages/smithers/build/targets"
    })
    const target = Smithers.Filegroup({ srcs: [dependency], cwd: "packages/smithers/build/targets" })
    expect(Target.metadata(target).dependencies[0]).toBe(dependency)
  })
})

/*
 * Presentation rides the declaration (Target.Presentation): `summary` and
 * `featured` sit beside the attrs in PACKAGE.ts, land in the metadata a
 * listing prints, and never reach the schema, so the attrs identity of an
 * annotated target is the identity of the bare one.
 */
describe("a declaration's presentation", () => {
  const bare = () => Smithers.Shell.Test({ bun: "console.log('hi')" })

  it("is absent by default", () => {
    const metadata = Target.metadata(bare())
    expect(metadata.summary).toBeUndefined()
    expect(metadata.featured).toBe(false)
  })

  it("carries the summary and the featured flag without touching the attrs", () => {
    const annotated = Smithers.Shell.Test({ bun: "console.log('hi')", summary: "  Says hi.  ", featured: true })
    const metadata = Target.metadata(annotated)
    expect(metadata.summary).toBe("Says hi.")
    expect(metadata.featured).toBe(true)
    expect(metadata.attrs).toEqual(Target.metadata(bare()).attrs)
    expect(Object.keys(metadata.attrs as object)).not.toContain("summary")
  })

  it("rejects a summary that is not one line of text, and a featured that is not a boolean", () => {
    expect(() => Smithers.Shell.Test({ bun: "true", summary: "" })).toThrow(/summary must not be empty/)
    expect(() => Smithers.Shell.Test({ bun: "true", summary: "two\nlines" })).toThrow(/summary must be one line/)
    expect(() => Smithers.Shell.Test({ bun: "true", summary: 7 as never })).toThrow(/summary must be a string/)
    expect(() => Smithers.Shell.Test({ bun: "true", featured: "yes" as never })).toThrow(/featured must be a boolean/)
  })

  it("passes through a guarded rule's own validation", () => {
    // Shell.Test requires one executable; the presentation keys must not count as one.
    expect(() => Smithers.Shell.Test({ summary: "no executable" } as never)).toThrow()
    expect(Target.metadata(Smithers.Shell.Test({ shell: "true", summary: "One line." })).summary).toBe("One line.")
  })
})
