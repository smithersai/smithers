import { Option } from "effect"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import { evaluate, Rule } from "../src/Permission.ts"

const write = (resource: string): Capability.Capability => Capability.make("fs:write", resource)

describe("Capability.tierOf lexical escape boundaries", () => {
  /**
   * Known limit: lexical classification cannot see symlinks; callers that
   * materialize snapshots must resolve links first.
   */
  it("classifies a lexically-inside symlink escape as compensable without filesystem access", () => {
    const resourceWhoseFirstSegmentIsReallyASymlink = "linked-outside/secret.txt"

    expect(Capability.tierOf(write(resourceWhoseFirstSegmentIsReallyASymlink), { workspaceRoot: "/workspace" }))
      .toBe("compensable")
  })

  it("classifies parent traversal that escapes the workspace as irreversible", () => {
    expect(Capability.tierOf(write("a/../../outside"), { workspaceRoot: "/workspace" })).toBe("irreversible")
  })

  it("keeps POSIX backslashes literal when classifying workspace writes", () => {
    expect(Capability.tierOf(write("/workspace\\evil"), { workspaceRoot: "/workspace" }))
      .toBe("irreversible")
    expect(
      Capability.tierOf(write("/tmp/evil\\..\\..\\workspace\\x"), { workspaceRoot: "/workspace" })
    ).toBe("irreversible")
  })
})

describe("Capability.tierOf foreign-rooted resources", () => {
  it.each([
    ["C:\\Windows\\x"],
    ["c:/Windows/x"],
    ["\\\\host\\share\\x"],
    ["\\Windows\\x"],
    ["a\\..\\..\\x"],
    ["~/.ssh/authorized_keys"]
  ])("classifies %s as irreversible under a POSIX root", (resource) => {
    expect(Capability.tierOf(write(resource), { workspaceRoot: "/w" })).toBe("irreversible")
  })

  it("keeps an ordinary relative resource compensable", () => {
    expect(Capability.tierOf(write("src/a~b.ts"), { workspaceRoot: "/w" })).toBe("compensable")
  })
})

describe("uncanonicalized filesystem resources", () => {
  const grant = Capability.parsePattern("fs:write:/w/**")

  it.each([
    ["/w//x"],
    ["/w/x/"],
    ["//w/x"],
    ["//"],
    ["C:/"],
    ["~/"],
    ["/w///x//"],
    ["/w/../etc/passwd"],
    ["/w/./x"],
    ["/w/a/.."],
    [".."],
    ["../etc/passwd"],
    ["src/../../etc"],
    ["C:/w/../x"],
    [
      "~/../x"
    ],
    ["x\\y/../z"]
  ])(
    "no grant selects %s",
    (resource) => {
      expect(Option.isSome(grant)).toBe(true)
      const pattern = Option.getOrThrow(grant)
      const all = new Capability.CapabilityPattern({ action: "*", resource: "**" })
      for (const action of ["fs:read", "fs:write"] as const) {
        const capability = Capability.make(action, resource)
        expect(Capability.matches(pattern, capability)).toBe(false)
        expect(Capability.matches(all, capability)).toBe(false)
        expect(evaluate([[new Rule({ effect: "allow", pattern: all })]], capability)).toBe("deny")
        expect(Capability.subsumes(all, new Capability.CapabilityPattern({ action, resource }))).toBe(false)
      }
    }
  )

  it("evaluates a dot-segment resource to deny even under an allow rule", () => {
    const allow = new Rule({ effect: "allow", pattern: Option.getOrThrow(grant) })
    expect(evaluate([[allow]], write("/w/../etc/passwd"))).toBe("deny")
    expect(evaluate([[allow]], write("/w/etc/passwd"))).toBe("allow")
  })

  it("does not prove /w/** covers /w/../**", () => {
    const covering = Option.getOrThrow(grant)
    expect(
      Capability.subsumes(covering, new Capability.CapabilityPattern({ action: "fs:write", resource: "/w/../**" }))
    )
      .toBe(false)
    expect(Capability.subsumes(covering, new Capability.CapabilityPattern({ action: "fs:write", resource: "/w/a/**" })))
      .toBe(true)
  })

  it.each([["."], ["./src/./out"], ["src/nested/../out"], ["src//out"], ["src/out/"]])(
    "an allow-all grant selects the declared scope %s",
    (resource) => {
      const all = new Capability.CapabilityPattern({ action: "*", resource: "**" })
      const read = Capability.make("fs:read", resource)
      expect(Capability.matches(all, read)).toBe(true)
      expect(evaluate([[new Rule({ effect: "allow", pattern: all })]], read)).toBe("allow")
      expect(Capability.subsumes(all, new Capability.CapabilityPattern({ action: "fs:read", resource }))).toBe(true)
    }
  )

  it("requires a relative grant to select the normal form as well as the text", () => {
    const src = new Capability.CapabilityPattern({ action: "fs:write", resource: "src/**" })
    expect(Capability.matches(src, write("src/nested/../out"))).toBe(true)
    expect(Capability.matches(src, write("src/a/../../etc/passwd"))).toBe(false)
    expect(
      Capability.subsumes(src, new Capability.CapabilityPattern({ action: "fs:write", resource: "src/a/../../**" }))
    )
      .toBe(false)
    expect(Capability.subsumes(src, new Capability.CapabilityPattern({ action: "fs:write", resource: "src/*/../x" })))
      .toBe(false)
    expect(evaluate([[new Rule({ effect: "allow", pattern: src })]], write("src/../../etc"))).toBe("deny")
  })

  it.each([["x/../secrets/key"], ["./secrets/key"], ["secrets/./key"], ["secrets/key/."], ["secrets//key"], [
    "secrets/key/"
  ], ["secrets///key//"]])(
    "a deny or ask on the normal form still applies to %s",
    (resource) => {
      const rule = (effect: "allow" | "deny" | "ask", pattern: string) =>
        new Rule({ effect, pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: pattern }) })
      const allowAll = rule("allow", "**")
      expect(evaluate([[allowAll, rule("deny", "secrets/key")]], write(resource))).toBe("deny")
      expect(evaluate([[allowAll, rule("deny", "secrets/**")]], write(resource))).toBe("deny")
      expect(evaluate([[allowAll, rule("ask", "secrets/key")]], write(resource))).toBe("ask")
      expect(evaluate([[rule("deny", "secrets/key")], [allowAll]], write(resource))).toBe("deny")
      expect(evaluate([[allowAll, rule("deny", "other/key")]], write(resource))).toBe("allow")
    }
  )

  it("empty segments cannot bypass restrictions on a generated normal path", () => {
    const segment = FastCheck.string({ unit: FastCheck.constantFrom("a", "b", "c"), minLength: 1, maxLength: 8 })
    FastCheck.assert(
      FastCheck.property(
        FastCheck.constantFrom("fs:read", "fs:write"),
        FastCheck.array(segment, { minLength: 2, maxLength: 6 }),
        FastCheck.nat({ max: 20 }),
        FastCheck.integer({ min: 1, max: 4 }),
        (action, segments, position, count) => {
          const index = position % segments.length + 1
          const resource = [...segments.slice(0, index), ...Array<string>(count).fill(""), ...segments.slice(index)]
            .join("/")
          const normal = segments.join("/")
          const all = new Capability.CapabilityPattern({ action, resource: "**" })
          const allow = new Rule({ effect: "allow", pattern: all })
          const exact = new Capability.CapabilityPattern({ action, resource: normal })
          const capability = Capability.make(action, resource)
          for (const clean of [normal, `/${normal}`]) {
            const literal = new Capability.CapabilityPattern({ action, resource: clean })
            const cleanCapability = Capability.make(action, clean)
            expect(Capability.matches(literal, cleanCapability)).toBe(true)
            expect(Capability.matches(literal, Capability.make(action, `${clean}x`))).toBe(false)
            expect(evaluate([[new Rule({ effect: "allow", pattern: literal })]], cleanCapability)).toBe("allow")
            expect(Capability.subsumes(literal, literal)).toBe(true)
          }
          expect(Capability.matches(all, capability)).toBe(true)
          for (const effect of ["deny", "ask"] as const) {
            expect(evaluate([[allow, new Rule({ effect, pattern: exact })]], capability)).toBe(effect)
          }
          expect(evaluate([[new Rule({ effect: "deny", pattern: exact })], [allow]], capability)).toBe("deny")
          expect(Capability.matches(all, Capability.make(action, `/${resource}`))).toBe(false)
          expect(evaluate([[allow]], Capability.make(action, `/${resource}`))).toBe("deny")
        }
      ),
      { numRuns: 100, seed: 4532 }
    )
  })

  it.each(["fs:write", "fs:*", "*"] as const)("keeps the canonical root selectable by %s", (action) => {
    const root = new Capability.CapabilityPattern({ action, resource: "/" })
    expect(Capability.matches(root, write("/"))).toBe(true)
    expect(evaluate([[new Rule({ effect: "allow", pattern: root })]], write("/"))).toBe("allow")
    expect(Capability.subsumes(root, new Capability.CapabilityPattern({ action: "fs:write", resource: "/" })))
      .toBe(true)
  })

  it.each(["secrets//key", "secrets/key/"])("requires an allow to select the normal form of %s", (resource) => {
    const literal = new Capability.CapabilityPattern({ action: "fs:write", resource })
    expect(Capability.matches(literal, write(resource))).toBe(false)
    expect(evaluate([[new Rule({ effect: "allow", pattern: literal })]], write(resource))).toBe("ask")
    expect(Capability.subsumes(literal, literal)).toBe(false)
  })

  it("checks filesystem-selecting wildcard scopes while keeping exact network scopes textual", () => {
    const allActions = new Capability.CapabilityPattern({ action: "*", resource: "https://h/**" })
    const network = new Capability.CapabilityPattern({ action: "net:get", resource: "https://h/**" })
    const request = Capability.make("net:get", "https://h/x/")
    // A whole-authority scope also selects filesystem paths; an exact network
    // scope has no filesystem interpretation.
    expect(Capability.subsumes(allActions, allActions)).toBe(false)
    expect(Capability.subsumes(allActions, network)).toBe(true)
    expect(Capability.subsumes(network, network)).toBe(true)
    expect(Capability.matches(allActions, request)).toBe(true)
    expect(evaluate([[new Rule({ effect: "allow", pattern: allActions })]], request)).toBe("allow")
  })

  it("leaves dot segments literal for non-filesystem actions", () => {
    const pattern = new Capability.CapabilityPattern({ action: "net:get", resource: "https://h/**" })
    expect(Capability.matches(pattern, Capability.make("net:get", "https://h/a/../b"))).toBe(true)
  })
})
