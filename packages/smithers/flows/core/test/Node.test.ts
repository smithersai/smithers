import { Option } from "effect"
import { describe, expect, it, onTestFinished } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Effects from "../src/Effects.ts"
import * as internal from "../src/internal/node.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

const declaration = Effects.make({
  reads: ["src/**"],
  writes: ["dist/**"],
  mode: "hermetic",
  onConflict: "serialize"
})

// Hosts without structuredClone refuse object capture because they cannot
// prove that an admitted ordinary-looking object is Proxy-free.
const withoutExoticDetection = (): void => {
  const clone = globalThis.structuredClone
  Reflect.deleteProperty(globalThis, "structuredClone")
  onTestFinished(() => {
    globalThis.structuredClone = clone
  })
}

describe("Node", () => {
  it("constructs succeed, all, and dynamic AST nodes", () => {
    const name = Node.succeed("Ada")
    const age = Node.succeed(37)
    const combined = Node.all({ name, age })
    const dynamic = Node.dynamic({
      model: "test-model",
      flows: ["lookup"],
      output: { Type: "" },
      prompt: "Summarize",
      effects: declaration
    })

    expect(name.ast).toMatchObject({ _tag: "Succeed", value: "Ada" })
    expect(combined.ast).toMatchObject({
      _tag: "All",
      nodes: {
        name: name.ast,
        age: age.ast
      }
    })
    expect(dynamic.ast).toMatchObject({
      _tag: "Dynamic",
      model: "test-model",
      flows: ["lookup"],
      output: { Type: "" },
      prompt: "Summarize",
      effects: declaration
    })
    expect(Node.dynamic({}).ast).toMatchObject({ _tag: "Dynamic", flows: [] })
    expect(Node.isNode(combined)).toBe(true)
    expect(Node.isNode({ ast: combined.ast })).toBe(false)
  })

  it("supports data-first and data-last map", () => {
    const source = Node.succeed(2)
    const increment = (value: number) => value + 1
    const dataFirst = Node.map(source, increment)
    const dataLast = source.pipe(Node.map((value) => value * 3))

    expect(dataFirst.ast._tag).toBe("Map")
    expect(dataLast.ast._tag).toBe("Map")
    if (dataFirst.ast._tag === "Map" && dataLast.ast._tag === "Map") {
      expect(dataFirst.ast.first).toBe(source.ast)
      expect(dataFirst.ast.mapper).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataLast.ast.first).toBe(source.ast)
      expect(dataLast.ast.mapper).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataFirst.ast.mapper).not.toEqual(dataLast.ast.mapper)
      expect(JSON.stringify(dataFirst.ast)).not.toContain("increment")
    }
  })

  it("supports data-first and data-last andThen with deferred continuations", () => {
    const source = Node.succeed(2)
    let continuationCalls = 0
    const stringify = (value: number) => {
      continuationCalls++
      return Node.succeed(String(value))
    }
    const dataFirst = Node.andThen(source, stringify)
    const dataLast = source.pipe(Node.andThen((value) => Node.succeed(value * 3)))
    const next = Node.succeed("done")
    const staticFirst = Node.andThen(source, next)
    const staticLast = source.pipe(Node.andThen(next))

    expect(continuationCalls).toBe(0)
    for (const node of [dataFirst, dataLast, staticFirst, staticLast]) {
      expect(node.ast._tag).toBe("AndThen")
    }
    if (
      dataFirst.ast._tag === "AndThen" &&
      dataLast.ast._tag === "AndThen" &&
      staticFirst.ast._tag === "AndThen" &&
      staticLast.ast._tag === "AndThen"
    ) {
      expect(dataFirst.ast.continuation).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataLast.ast.continuation).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataFirst.ast.continuation).not.toEqual(dataLast.ast.continuation)
      expect(staticFirst.ast.continuation).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "static-node/v1",
        digest: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
      expect(staticLast.ast.continuation).toEqual(staticFirst.ast.continuation)
      expect(staticFirst.ast.next).toBe(next.ast)
      expect(staticLast.ast.next).toBe(next.ast)
      expect(continuationCalls).toBe(0)
    }
  })

  it("supports data-first and data-last within", () => {
    const source = Node.succeed("value")
    const placement = Placement.sandbox({ image: "flows:test" })
    const dataFirst = Node.within(source, placement)
    const dataLast = source.pipe(Node.within(placement))

    expect(Option.getOrUndefined(Annotations.getOption(dataFirst.ast.annotations, Annotations.Placement))).toBe(
      placement
    )
    expect(Option.getOrUndefined(Annotations.getOption(dataLast.ast.annotations, Annotations.Placement))).toBe(
      placement
    )
  })

  it("supports data-first and data-last lane", () => {
    const source = Node.succeed("value")
    const options = { id: "review", landing: "merge-queue" } as const
    const dataFirst = Node.lane(source, options)
    const dataLast = source.pipe(Node.lane(options))

    expect(Option.getOrUndefined(Annotations.getOption(dataFirst.ast.annotations, Annotations.Lane))).toBe(options)
    expect(Option.getOrUndefined(Annotations.getOption(dataLast.ast.annotations, Annotations.Lane))).toBe(options)
  })

  it("supports data-first and data-last withEffects", () => {
    const source = Node.succeed("value")
    const dataFirst = Node.withEffects(source, declaration)
    const dataLast = source.pipe(Node.withEffects(declaration))

    expect(Option.getOrUndefined(Annotations.getOption(dataFirst.ast.annotations, Annotations.Effects))).toBe(
      declaration
    )
    expect(Option.getOrUndefined(Annotations.getOption(dataLast.ast.annotations, Annotations.Effects))).toBe(
      declaration
    )
  })

  it("does not mutate the original AST or annotations while piping", () => {
    const source = Node.succeed({ value: 1 })
    const originalAst = source.ast
    const placed = source.pipe(Node.within(Placement.local()))
    const mapped = source.pipe(Node.map((value) => value.value))

    expect(source.ast).toBe(originalAst)
    expect(placed).not.toBe(source)
    expect(placed.ast).not.toBe(source.ast)
    expect(mapped).not.toBe(source)
    expect(mapped.ast).not.toBe(source.ast)
    expect(Option.isNone(Annotations.getOption(source.ast.annotations, Annotations.Placement))).toBe(true)
  })

  it("constructs structurally identical ASTs deterministically", () => {
    const build = () =>
      Node.all({
        input: Node.succeed({ id: 42 }),
        model: Node.dynamic({
          model: "test-model",
          flows: ["lookup"],
          prompt: "Inspect"
        })
      })

    expect(build().ast).toEqual(build().ast)
  })

  it("uses full SHA-256 identities without source normalization collisions", () => {
    function f2152() {
      return 2152
    }
    function f19965() {
      return 19965
    }
    const identity = (operation: () => unknown) => {
      const ast = Node.map(Node.succeed(undefined), operation).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }

    const one = identity(f2152)
    const two = identity(f19965)
    expect(one.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(one).not.toEqual(two)
    expect(identity(Function("return 'one space'") as () => unknown))
      .not.toEqual(identity(Function("return 'one  space'") as () => unknown))
  })

  it("fails closed when separate raw closures have indistinguishable source", () => {
    const make = (offset: number) => (value: number) => value + offset
    const one = make(1)
    const alsoOne = make(1)
    const identity = (operation: (value: number) => number) => {
      const ast = Node.map(Node.succeed(1), operation).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }

    expect(identity(one)).toEqual(identity(one))
    expect(identity(one)).not.toEqual(identity(alsoOne))
    expect(() => internal.functionIdentity(null)).toThrow(/requires a function/)
  })

  it("includes declared captures in identity and binds frozen copies", () => {
    const make = (offset: number) => {
      const captures = { offset, nested: { stable: true } }
      const operation = Node.capture(captures, function(value: number) {
        return value + this.offset
      })
      return { captures, operation, node: Node.map(Node.succeed(1), operation) }
    }
    const one = make(1)
    const same = make(1)
    const two = make(2)
    const identity = (node: Node.Node<number>) => {
      if (node.ast._tag !== "Map") throw new Error("expected Map")
      return node.ast.mapper
    }

    expect(one.operation(2)).toBe(3)
    expect(identity(one.node)).toEqual(identity(same.node))
    expect(identity(one.node)).not.toEqual(identity(two.node))
    expect(identity(one.node).algorithm).toBe("sha256-source-captures/v4")
    expect(Node.functionIdentity(one.operation)).toEqual(identity(one.node))
    expect(Object.isFrozen(one.captures)).toBe(false)
    expect(Object.isFrozen(one.captures.nested)).toBe(false)
    expect(() => Node.capture({ value: Number.NaN }, () => undefined)).toThrow(/is not finite/)
  })

  it.each(
    [
      ["frozen outer with mutable inner", () => ({ config: Object.freeze({ nested: { value: 5 } }) })],
      ["frozen root with object child", () => Object.freeze({ config: { value: 5 } })],
      ["frozen array of records", () => ({ config: Object.freeze([{ value: 5 }]) })],
      ["three-level frozen constant", () =>
        Object.freeze({
          config: Object.freeze({ nested: Object.freeze({ value: 5 }) })
        })],
      ["non-configurable non-writable member", () =>
        Object.defineProperty({ mutable: true }, "config", {
          value: { value: 5 },
          enumerable: true,
          configurable: false,
          writable: false
        })],
      ["frozen null-prototype record", () =>
        Object.freeze(Object.assign(Object.create(null), {
          config: { value: 5 }
        }))],
      ["frozen-vs-plain twin identity parity", () => ({ config: Object.freeze({ nested: { value: 5 } }), tag: 1 })]
    ] as const
  )("captures caller-frozen data: %s", (_name, make) => {
    const captures = make()
    const plain = JSON.parse(JSON.stringify(captures)) as Record<string, unknown>
    const prototype = Object.getPrototypeOf(captures)
    const initiallyFrozen = Object.isFrozen(captures)
    const originals: Array<readonly [object, boolean]> = []
    const collect = (value: unknown): void => {
      if (value === null || typeof value !== "object") return
      originals.push([value, Object.isFrozen(value)])
      for (const child of Object.values(value)) collect(child)
    }
    collect(captures)
    const operation = function(this: Record<string, unknown>) {
      return JSON.stringify(this)
    }
    const wrapped = Node.capture(captures, operation)

    expect(JSON.parse(wrapped())).toEqual(plain)
    expect(Node.functionIdentity(wrapped).algorithm).toBe("sha256-source-captures/v4")
    expect(Node.functionIdentity(wrapped)).toEqual(Node.functionIdentity(Node.capture(plain, operation)))
    expect(Node.functionIdentity(Node.capture(captures, operation))).toEqual(Node.functionIdentity(wrapped))
    for (const [original, frozen] of originals) expect(Object.isFrozen(original)).toBe(frozen)
    if (initiallyFrozen) expect(Object.getPrototypeOf(captures)).toBe(prototype)
  })

  it("captures an Immer-style auto-frozen tree with shared records and arrays", () => {
    const item = Object.freeze({ value: 5 })
    const config = Object.freeze({ selected: item, items: Object.freeze([item]) })
    const state = Object.freeze({ config, version: 2 })
    const operation = Node.capture({ state }, function() {
      return this.state.config.items[0]!.value
    })
    const identity = Node.functionIdentity(operation)

    expect(operation()).toBe(5)
    expect(state.config).toBe(config)
    expect(config.selected).toBe(config.items[0])
    expect(Reflect.set(item, "value", 6)).toBe(false)
    expect(operation()).toBe(5)
    expect(Node.functionIdentity(operation)).toEqual(identity)
    expect(Node.functionIdentity(Node.capture({ state }, operation)).algorithm).toBe("sha256-source-captures/v4")
  })

  it("still refuses frozen Proxies and frozen trees with accessors or custom prototypes", () => {
    const exotic = new Proxy(Object.freeze({ child: Object.freeze({ value: 1 }) }), {})
    expect(() => Node.capture(Object.freeze({ exotic }), () => exotic.child.value))
      .toThrow(/capture at \$\.exotic cannot be structured-cloned/)
    const custom = Object.freeze(Object.assign(Object.create({ inherited: 1 }), { value: 1 }))
    expect(() => Node.capture(Object.freeze({ custom }), () => custom.value))
      .toThrow(/capture at \$\.custom has a non-plain prototype/)
    let reads = 0
    const accessor = Object.freeze(Object.defineProperty({}, "value", { enumerable: true, get: () => ++reads }))
    expect(() => Node.capture(Object.freeze({ accessor }), () => accessor))
      .toThrow(/capture at \$\.accessor.value is an accessor/)
    expect(reads).toBe(0)
  })

  it("refuses a Proxy after one descriptor snapshot and before locking anything", () => {
    let reads = 0
    const target = { x: 1 }
    const captures = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        reads++
        return Reflect.getOwnPropertyDescriptor(object, key)
      }
    })

    expect(() => Node.capture(captures, () => captures.x)).toThrow(
      /Node.capture: capture at \$ cannot be structured-cloned/
    )
    expect(reads).toBe(1)
    expect(Object.isFrozen(target)).toBe(false)
    expect(Object.getOwnPropertyDescriptor(target, "x")).toEqual({
      value: 1,
      enumerable: true,
      configurable: true,
      writable: true
    })
  })

  it("names the exotic object itself, not the record that holds it", () => {
    const nested = { deep: new Proxy({ value: 1 }, {}) }
    const captures = { nested }

    expect(() => Node.capture(captures, () => nested.deep.value)).toThrow(
      new TypeError(
        "Node.capture: capture at $.nested.deep cannot be structured-cloned (for example, a Proxy); " +
          "captures must be finite, inert data"
      )
    )
    expect(Object.isFrozen(captures)).toBe(false)
  })

  it("refuses the record and array Proxies whose own key order can still move", () => {
    // Declared, read through a binding of the caller's own and left frozen,
    // these two returned "1,2" and then "2,1" under one identity. A frozen
    // ordinary object cannot do that, so refusing them at admission is what
    // keeps identity and behavior together.
    for (const target of [{ a: 1, b: 2 }, [1, 2]] as ReadonlyArray<object>) {
      let reversed = false
      const exotic = new Proxy(target, {
        ownKeys: (object) => reversed ? Reflect.ownKeys(object).reverse() : Reflect.ownKeys(object)
      })

      expect(() => Node.capture({ exotic }, () => Object.values(exotic).join(","))).toThrow(
        /Node.capture: capture at \$\.exotic cannot be structured-cloned/
      )
      reversed = true
      expect(Object.isFrozen(target)).toBe(false)
    }
  })

  it("refuses mutable custom array prototypes before capturing their behavior", () => {
    const array = [1] as Array<number> & { x: number }
    const prototype = { x: 1 }
    Object.setPrototypeOf(array, prototype)
    const operation = () => array.x
    expect(operation()).toBe(1)
    expect(() => Node.capture({ array }, operation)).toThrow(/capture at \$\.array has a non-plain prototype/)
    prototype.x = 2
    expect(operation()).toBe(2)
    expect(Object.isFrozen(array)).toBe(false)
  })

  it("refuses inherited array accessors without evaluating them", () => {
    let current = 1
    let reads = 0
    class MutableArray extends Array<number> {
      get x() {
        reads++
        return current
      }
    }
    const array = new MutableArray()
    array.push(1)
    const operation = () => array.x
    expect(() => Node.capture({ array }, operation)).toThrow(/capture at \$\.array has a non-plain prototype/)
    expect(reads).toBe(0)
    expect(operation()).toBe(1)
    current = 2
    expect(operation()).toBe(2)
    expect(Object.isFrozen(array)).toBe(false)
  })

  it("reads aliased descriptors once and array length without invoking get traps", () => {
    let reads = 0
    const shared = new Proxy({ value: 1 }, {
      getOwnPropertyDescriptor(target, key) {
        reads++
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    let lengthReads = 0
    const values = new Proxy([shared], {
      get(target, key, receiver) {
        if (key === "length") lengthReads++
        return Reflect.get(target, key, receiver)
      }
    })
    expect(() => Node.capture({ left: shared, right: shared, values }, () => undefined))
      .toThrow(/cannot be structured-cloned/)
    expect(reads).toBe(1)
    expect(lengthReads).toBe(0)
  })

  it("rejects invalid array lengths supplied by a Proxy descriptor", () => {
    for (const length of [Number.NaN, -1, 0x100000000]) {
      const array = new Proxy([], {
        getOwnPropertyDescriptor(target, key) {
          return { ...Reflect.getOwnPropertyDescriptor(target, key), value: length }
        }
      })
      expect(() => Node.capture({ array }, () => array.length)).toThrow(/has an invalid array length/)
    }
  })

  it("copies enumerable prototype-like members as plain own data", () => {
    const captures = Object.create(null)
    const nested = { value: 1 }
    Object.defineProperty(captures, "__proto__", { value: nested, enumerable: true, configurable: true })
    const operation = Node.capture(captures, function() {
      return this
    })
    const copy = operation()
    expect(copy.__proto__.value).toBe(1)
    expect(copy).not.toBe(captures)
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(captures)).toBe(null)
    expect(Object.isFrozen(copy)).toBe(true)
    expect(copy.__proto__).not.toBe(nested)
    expect(Object.isFrozen(copy.__proto__)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(copy, "__proto__")?.enumerable).toBe(true)
  })

  it("refuses non-enumerable capture data and accessors without evaluating getters", () => {
    let reads = 0
    const accessor = Object.defineProperty({}, "hidden", { get: () => ++reads })
    expect(() => Node.capture(accessor, () => undefined)).toThrow(/\$\.hidden is an accessor/)
    expect(reads).toBe(0)
    const hidden = Object.defineProperty({}, "hidden", { value: 1 })
    expect(() => Node.capture(hidden, () => undefined)).toThrow(/\$\.hidden is non-enumerable/)
    const values = Object.defineProperty([1], "0", { enumerable: false })
    expect(() => Node.capture({ values }, () => undefined)).toThrow(/\$\.values\[0\] is non-enumerable/)
  })

  it("preserves shared references in frozen copies across repeated captures", () => {
    const original = Object.assign(Object.create(null), { value: 1 })
    const values = [original]
    const captures = { left: original, right: original, values }
    const operation = function(this: typeof captures) {
      return this
    }
    const wrapped = Node.capture(captures, operation)
    const copy = wrapped()
    expect(copy.left).not.toBe(original)
    expect(copy.left).toBe(copy.right)
    expect(copy.values).not.toBe(values)
    expect(copy.values[0]).toBe(copy.left)
    expect(Object.getPrototypeOf(copy.left)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(copy.values)).toBe(Array.prototype)
    expect(Object.isFrozen(copy.values)).toBe(true)
    expect(Object.isFrozen(copy.left)).toBe(true)
    const repeated = Node.capture(copy, operation)
    expect(repeated()).toEqual(copy)
    expect(Node.functionIdentity(repeated)).toEqual(Node.functionIdentity(wrapped))
  })

  it("refuses the earlier mutation, locking and ownKeys Proxy reproducers", () => {
    const handlers: Array<ProxyHandler<{ value: number }>> = [
      {
        isExtensible: () => {
          throw new Error("cannot inspect")
        }
      },
      { setPrototypeOf: () => false },
      { preventExtensions: () => false },
      { defineProperty: () => true },
      {
        preventExtensions(target) {
          Object.defineProperty(target, "extra", { value: 2 })
          return Reflect.preventExtensions(target)
        }
      },
      {
        preventExtensions(target) {
          Object.setPrototypeOf(target, { mutable: true })
          return Reflect.preventExtensions(target)
        }
      },
      {
        preventExtensions(target) {
          Object.defineProperty(target, "value", { get: () => 4, configurable: true })
          return Reflect.preventExtensions(target)
        }
      }
    ]
    for (const handler of handlers) {
      const target = { value: 1 }
      const nested = new Proxy(target, handler)
      expect(() => Node.capture({ nested }, () => nested.value)).toThrow(
        /capture at \$\.nested cannot be structured-cloned/
      )
      expect(Object.getOwnPropertyDescriptor(target, "value")?.value).toBe(1)
      expect(Object.isExtensible(target)).toBe(true)
    }
    let locking = false
    const nested = new Proxy({ first: 1, second: 2 }, {
      ownKeys: (object) => locking ? Reflect.ownKeys(object).reverse() : Reflect.ownKeys(object),
      preventExtensions(object) {
        locking = true
        return Reflect.preventExtensions(object)
      }
    })
    expect(() => Node.capture({ nested }, () => Object.keys(nested).join(",")))
      .toThrow(/capture at \$\.nested cannot be structured-cloned/)
    expect(locking).toBe(false)
  })

  it("refuses all object capture without structuredClone, including closure-alias Proxies", () => {
    withoutExoticDetection()
    expect(() => Node.capture({ plain: 1 }, () => undefined)).toThrow(/capture at \$ requires structuredClone/)
    for (const target of [{ a: 1, b: 2 }, [1, 2]] as ReadonlyArray<object>) {
      let reversed = false
      const alias = new Proxy(target, {
        ownKeys: (object) => reversed ? Reflect.ownKeys(object).reverse() : Reflect.ownKeys(object)
      })
      expect(() => Node.capture({ alias }, () => Object.values(alias).join(",")))
        .toThrow(/capture at \$ requires structuredClone/)
      reversed = true
      expect(Object.isFrozen(target)).toBe(false)
    }
  })

  it("leaves state the caller never declared to the caller's contract", () => {
    // JavaScript cannot rebind the free variables of an existing function, so
    // identity can only cover what the caller declares. Undeclared state is
    // outside capture's own-data contract even on hosts with structuredClone.
    let counter = 0
    const undeclared = Node.capture({}, () => ++counter)
    const identity = Node.functionIdentity(undeclared)

    expect(undeclared()).toBe(1)
    expect(undeclared()).toBe(2)
    expect(Node.functionIdentity(undeclared)).toEqual(identity)
  })

  it("composes nested capture identity without erasing the inner operation", () => {
    const identity = (operation: (value: number) => number) => {
      const ast = Node.map(Node.succeed(1), operation).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }
    const add = (value: number) => value + 1
    const multiply = (value: number) => value * 2

    expect(identity(Node.capture({ outer: 1 }, Node.capture({ inner: 2 }, add))))
      .not.toEqual(identity(Node.capture({ outer: 1 }, Node.capture({ inner: 2 }, multiply))))
    expect(identity(Node.capture({ outer: 1 }, Node.capture({ inner: 2 }, add))))
      .not.toEqual(identity(Node.capture({ outer: 1 }, Node.capture({ inner: 3 }, add))))
  })

  it("keeps identical nested captures stable and distinct from a single capture", () => {
    const operation = (value: number) => value + 1
    const identity = (captured: (value: number) => number) => {
      const ast = Node.map(Node.succeed(1), captured).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }
    const nested = () => Node.capture({ outer: 1 }, Node.capture({ inner: 2 }, operation))

    expect(identity(nested())).toEqual(identity(nested()))
    expect(identity(nested())).not.toEqual(identity(Node.capture({ inner: 2, outer: 1 }, operation)))
  })

  it("rejects a malformed capture operation with the package-shaped message", () => {
    expect(() => Node.capture({}, "nope" as unknown as () => unknown))
      .toThrow(new TypeError("Node.capture requires a function operation"))
    for (const value of [null, 1]) {
      expect(() => Node.capture(value as unknown as Record<string, unknown>, () => undefined))
        .toThrow(/capture at \$ must be a record/)
    }
  })

  it("canonicalizes every supported capture shape and rejects ambiguous data", () => {
    const operation = () => undefined
    const identity = (captures: Readonly<Record<string, unknown>>) => {
      const ast = Node.map(Node.succeed(undefined), Node.capture(captures, operation)).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }

    expect(identity({ a: 1, b: 2 })).toEqual(identity({ b: 2, a: 1 }))
    expect(identity({ value: -0 })).not.toEqual(identity({ value: 0 }))
    expect(() => identity({ array: [null, true, false, "text"], empty: Object.create(null) })).not.toThrow()
    const shared = { value: 1 }
    expect(() => identity({ left: shared, right: shared })).not.toThrow()

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => identity(cyclic)).toThrow(/is cyclic/)
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 })
    expect(() => identity(accessor)).toThrow(/is an accessor/)
    expect(() => identity({ [Symbol("key")]: 1 })).toThrow(/has symbol key/)
    expect(() => identity({ date: new Date(0) })).toThrow(/built-in internal slots/)
    expect(() => identity({ values: Array(1) })).toThrow(/is an array hole/)
    for (const value of [undefined, 1n, Symbol("value"), operation]) {
      expect(() => identity({ value })).toThrow(/has unsupported type/)
    }

    const arrayAccessor: Array<unknown> = []
    Object.defineProperty(arrayAccessor, "0", { enumerable: true, get: () => 1 })
    expect(() => identity({ arrayAccessor })).toThrow(/is an accessor/)
    const arrayProperty: Array<unknown> = []
    Object.defineProperty(arrayProperty, "extra", { enumerable: true, value: 1 })
    expect(() => identity({ arrayProperty })).toThrow(/unsupported array key extra/)
    const arraySymbol: Array<unknown> = []
    Object.defineProperty(arraySymbol, Symbol("extra"), { enumerable: true, value: 1 })
    expect(() => identity({ arraySymbol })).toThrow(/unsupported array key Symbol\(extra\)/)

    const baseline = identity({ array: [1, 2, 3] })
    expect(identity({ array: [1, 2, 3] })).toEqual(baseline)

    const ghost = [1, 2, 3]
    Object.defineProperty(ghost, "4294967295", { enumerable: true, value: 4 })
    expect(() => identity({ array: ghost })).toThrow(
      new TypeError(
        "Node.capture: capture at $.array has unsupported array key 4294967295; captures must be finite, inert data"
      )
    )

    let outOfRangeDescriptor: PropertyDescriptor | undefined
    const outOfRange = new Proxy([1, 2, 3], {
      defineProperty: (target, key, descriptor) => {
        if (key !== "10") return Reflect.defineProperty(target, key, descriptor)
        outOfRangeDescriptor = { ...descriptor, configurable: true }
        return true
      },
      getOwnPropertyDescriptor: (target, key) =>
        key === "10" ? outOfRangeDescriptor : Reflect.getOwnPropertyDescriptor(target, key),
      ownKeys: (target) => [...Reflect.ownKeys(target), "10"]
    })
    Object.defineProperty(outOfRange, "10", { configurable: true, enumerable: true, value: 4 })
    expect(Object.hasOwn(outOfRange, "10")).toBe(true)
    expect(() => identity({ array: outOfRange })).toThrow(
      new TypeError(
        "Node.capture: capture at $.array has unsupported array key 10; captures must be finite, inert data"
      )
    )
  })

  it("bounds capture nesting with an exact typed error", () => {
    const nested = (depth: number): Readonly<Record<string, unknown>> => {
      let value: unknown = "leaf"
      for (let index = 0; index < depth; index++) value = { value }
      return value as Readonly<Record<string, unknown>>
    }
    const operation = () => undefined

    expect(() => Node.capture(nested(256), operation)).not.toThrow()
    const path = `$${".value".repeat(257)}`
    expect(() => Node.capture(nested(257), operation)).toThrow(
      new TypeError(
        `Node.capture: capture at ${path} exceeds the maximum capture depth of 256; captures must be finite, inert data`
      )
    )
  })

  it("rejects non-Node members with NodeBuildError", () => {
    const invalid = { valid: Node.succeed("ok"), invalid: 42 } as unknown as Readonly<Record<string, Node.Any>>

    expect(() => Node.all(invalid)).toThrow(Node.NodeBuildError)
    try {
      Node.all(invalid)
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "flows/core/NodeBuildError",
        code: "invalid_all_member",
        member: "invalid"
      })
    }
  })

  it("retains prototype-like Node.all member names", () => {
    const combined = Node.all({
      ["__proto__"]: Node.succeed("proto"),
      constructor: Node.succeed("constructor"),
      prototype: Node.succeed("prototype")
    })

    if (combined.ast._tag !== "All") throw new Error("expected All")
    expect(Object.getPrototypeOf(combined.ast.nodes)).toBeNull()
    expect(Object.keys(combined.ast.nodes)).toEqual(["__proto__", "constructor", "prototype"])
  })
})
