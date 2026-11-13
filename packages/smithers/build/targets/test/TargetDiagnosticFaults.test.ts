import * as Schema from "effect/Schema"
import * as Issue from "effect/SchemaIssue"
import * as Vm from "node:vm"
import { describe, expect, it } from "vitest"
import * as Target from "../src/Target.ts"

const rejection = (issue: Issue.Issue): Error =>
  Target.declarationRejected("DiagnosticProbe", undefined, new Error("schema issue fallback", { cause: issue }))

const unexpected = (): Issue.UnexpectedKey => new Issue.UnexpectedKey(Schema.Struct({ known: Schema.String }).ast)

describe("declaration diagnostics reject malformed issue data", () => {
  it.each([undefined, null, 7, new Proxy({}, {}), {}])("bounds diagnostics with an unusable issue AST: %s", (ast) => {
    const issue = unexpected()
    Object.defineProperty(issue, "ast", { value: ast })
    const error = rejection(new Issue.Pointer(["unknown"], issue))
    expect(error.message).toContain("DiagnosticProbe declaration is invalid")
    expect(error.message.length).toBeLessThan(Target.maximumRejectionDetailCodeUnits + 100)
  })

  it("ignores unusable property signature entries while rendering accepted names", () => {
    const issue = unexpected()
    Object.defineProperty(issue, "ast", {
      value: { propertySignatures: [null, {}, { name: 7 }, { name: "known" }] }
    })
    const error = rejection(new Issue.Pointer(["unknown"], issue))
    expect(error.message).toContain("DiagnosticProbe declaration is invalid")
    expect(error.message.length).toBeLessThan(Target.maximumRejectionDetailCodeUnits + 100)
  })

  it.each(["path", "issue"])("handles a pointer without its own %s data member", (key) => {
    const issue = new Issue.Pointer(["unknown"], unexpected())
    delete (issue as unknown as Record<string, unknown>)[key]
    expect(rejection(issue).message).toContain("DiagnosticProbe declaration is invalid")
  })

  it("does not invent a property name for a root unexpected-key issue", () => {
    expect(rejection(unexpected()).message).not.toContain("unknown property")
  })

  it("continues past an unusable file URL in a real VM call site", () => {
    const make = Target.make("BadLocationProbe", {
      attrs: Schema.Struct({}),
      kinds: ["test"],
      implementation: Target.catalogNotImplemented
    })
    const declare = Vm.compileFunction("return make({})", ["make"], { filename: "file:///bad%ZZ/PACKAGE.ts" })
    const target = declare(make) as Target.AnyTarget
    expect(Target.metadata(target).target).toBe("BadLocationProbe")
    expect(Target.metadata(target).sourceFile).toBeUndefined()
  })

  it("omits a nonpositive source line from a real VM diagnostic", () => {
    const make = Target.make("ZeroLineProbe", {
      attrs: Schema.Struct({ known: Schema.String }),
      kinds: ["test"],
      implementation: Target.catalogNotImplemented
    })
    const declare = Vm.compileFunction("return make({ known: 1 })", ["make"], {
      filename: "/virtual/PACKAGE.ts",
      lineOffset: -1
    })
    expect(() => declare(make)).toThrow("ZeroLineProbe declaration at /virtual/PACKAGE.ts is invalid")
    expect(() => declare(make)).toThrow("/virtual/PACKAGE.ts")
  })
})

it("plans the shared catalog placeholder through the public target boundary", () => {
  const make = Target.make("CatalogPlaceholderProbe", {
    attrs: Schema.Struct({}),
    kinds: ["test"],
    implementation: Target.catalogNotImplemented
  })
  expect(Target.catalogNotImplemented().ast).toMatchObject({
    _tag: "ActionCall",
    action: "smithers-build/not-implemented",
    payload: { target: "catalog target" }
  })
  expect(Target.plan(make({})).ast).toMatchObject({
    _tag: "ActionCall",
    action: "smithers-build/not-implemented",
    payload: { target: "catalog target" }
  })
})

it("snapshots a sparse array as explicit undefined data before decoding unknown entries", () => {
  const make = Target.make("SparseUnknownProbe", {
    attrs: Schema.Struct({ entries: Schema.Array(Schema.Unknown) }),
    kinds: ["test"],
    implementation: Target.catalogNotImplemented
  })
  const target = make({ entries: Array(1) })
  const entries = (Target.metadata(target).attrs as { entries: ReadonlyArray<unknown> }).entries
  expect(entries).toEqual([undefined])
  expect(Object.hasOwn(entries, "0")).toBe(true)
  expect(Object.isFrozen(entries)).toBe(true)
})

it("rejects a custom prototype even when it has no constructor descriptor", () => {
  const make = Target.make("UnrecognizedPrototypeProbe", {
    attrs: Schema.Struct({ value: Schema.Unknown }),
    kinds: ["test"],
    implementation: Target.catalogNotImplemented
  })
  const value = Object.create(Object.create(null))
  expect(() => make({ value })).toThrow("got an object with a prototype of its own")
})

it("renders actionable guidance from a native issue supplied through the diagnostic boundary", () => {
  const issue = new Issue.Pointer(["typo"], unexpected())
  expect(Issue.isIssue(issue)).toBe(true)
  const error = rejection(issue)
  expect(error.message).toContain("unknown property \"typo\"")
  expect(error.message).toContain("accepted: known")
})

it("uses the first equally near accepted key rather than replacing it with a tie", () => {
  const issue = new Issue.UnexpectedKey(Schema.Struct({ abcd: Schema.String, abce: Schema.String }).ast)
  expect(rejection(new Issue.Pointer(["abcf"], issue)).message).toContain("did you mean \"abcd\"?")
})

it("bounds diagnostics for native issue containers with missing or malformed children", () => {
  const composite = new Issue.Composite(Schema.Struct({}).ast, [unexpected()])
  delete (composite as unknown as Record<string, unknown>).issues
  expect(rejection(composite).message).toContain("DiagnosticProbe declaration is invalid")
  const malformed = new Issue.Composite(Schema.Struct({}).ast, [unexpected(), {} as never, null as never])
  expect(rejection(malformed).message).toContain("DiagnosticProbe declaration is invalid")
})

it("handles a native unexpected-key issue whose AST data member is absent", () => {
  const issue = unexpected()
  delete (issue as unknown as Record<string, unknown>).ast
  expect(rejection(new Issue.Pointer(["unknown"], issue)).message).toContain("DiagnosticProbe declaration is invalid")
})
