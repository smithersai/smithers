/**
 * The shape a durable resume compares a callback by: its source with every
 * binding renamed by the order it is declared in.
 *
 * The first suites pin the shape token by token: what is kept, how bindings
 * are numbered and resolved through scopes, and which edits move it. The
 * last holds the shape against a real minifier over a real library: every
 * function `effect` exports, bundled and minified twice with different code
 * beside it, keeps its shape although most of their source changed.
 */
import * as Effect from "effect"
import * as esbuild from "esbuild"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import { functionIdentity } from "../src/Identity.ts"
import { sourceShape } from "../src/internal/sourceShape.ts"

const hostNames = [
  "arguments",
  "process",
  "Buffer",
  "require",
  "window",
  "self",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "setImmediate",
  "XMLHttpRequest",
  "Worker",
  "MessageChannel",
  "BroadcastChannel"
]

describe("sourceShape: what an edit moves", () => {
  it("gives a renamed but equivalent callback the same shape", () => {
    expect(sourceShape("(value) => value + 1")).toBe("( $0 ) => $0 + 1")
    expect(sourceShape("(e)=>e+1")).toBe(sourceShape("(value) => value + 1"))
    // esbuild and Oxc output for one callback in two bundles. Oxc's inner `t`
    // shadows the outer `t`; the inner use still reads its own binding.
    const esbuildBuild = "({answerId:n})=>u.call({answerId:n}).pipe(t.bindPlanned(e=>d.call({until:e})))"
    const oxcBuild = "({answerId:e})=>r.call({answerId:e}).pipe(t.bindPlanned(t=>i.call({until:t})))"
    expect(sourceShape(esbuildBuild)).toBe(sourceShape(oxcBuild))
    expect(sourceShape(esbuildBuild)).toBe(
      "( { answerId : $0 } ) => $f0 . call ( { answerId : $0 } ) . pipe ( $f1 . bindPlanned ( $1 => $f2 . call ( { until : $1 } ) ) )"
    )
  })

  it("distinguishes undeclared built-in globals without executing them", () => {
    const names = [
      "fetch",
      "eval",
      "JSON",
      "Math",
      "Object",
      "Array",
      "Promise",
      "globalThis",
      "undefined",
      "NaN",
      "Infinity",
      "URL",
      "crypto",
      "setTimeout",
      ...hostNames
    ]
    const shapes = names.map((name) => sourceShape(`() => ${name}(1)`))
    expect(new Set(shapes).size).toBe(names.length)
    const identities = names.map((name) => functionIdentity(Function(`return () => ${name}(1)`)()).resumeDigest)
    expect(new Set(identities).size).toBe(names.length)
  })

  it("resolves shadowed built-in names before preserving global names", () => {
    expect(sourceShape("fetch => fetch(1)")).toBe(sourceShape("e => e(1)"))
    expect(sourceShape("() => { return fetch(1); function fetch(x) { return x } }")).toBe(
      sourceShape("() => { return f(1); function f(e) { return e } }")
    )
    expect(sourceShape("() => { { let fetch = f; fetch(1) } return fetch(1) }")).toContain("return fetch ( 1 )")
    expect(sourceShape("() => [fetch(1), outer(2)]")).toBe(sourceShape("() => [fetch(1), renamed(2)]"))
  })

  it.each([
    ["function () { return arguments[0] }", "function () { return settings[0] }"],
    ["function () { return () => arguments[0] }", "function () { return () => settings[0] }"],
    ["() => localStorage.clear()", "() => sessionStorage.clear()"],
    ["() => process.exit(1)", "() => queue.exit(1)"],
    ["() => class { value = 1\n reader = () => process }", "() => class { value = 1\n reader = () => queue }"]
  ])("distinguishes %s from %s in resume identities", (before, after) => {
    expect(sourceShape(before)).not.toBe(sourceShape(after))
    const identity = (source: string) => functionIdentity(Function(`return (${source})`)()).resumeDigest
    expect(identity(before)).not.toBe(identity(after))
  })

  it("keeps host names distinct from free bindings while renaming their explicit shadows", () => {
    for (const name of hostNames) {
      expect(sourceShape(`() => ${name}`), name).not.toBe(sourceShape("() => outer"))
      expect(sourceShape(`(${name}) => ${name}`), name).toBe(sourceShape("(value) => value"))
      expect(sourceShape(`() => { const ${name} = outer; return ${name} }`), name).toBe(
        sourceShape("() => { const value = outer; return value }")
      )
    }
  })

  it("sees swapped arguments", () => {
    expect(sourceShape("(a, b) => a - b")).toBe("( $0 , $1 ) => $0 - $1")
    expect(sourceShape("(a, b) => b - a")).toBe("( $0 , $1 ) => $1 - $0")
  })

  it("sees swapped locals", () => {
    const before = "(x) => { const a = x * 2; const b = x + 1; return a / b }"
    const after = "(x) => { const a = x * 2; const b = x + 1; return b / a }"
    expect(sourceShape(before)).toBe("( $0 ) => { const $1 = $0 * 2 ; const $2 = $0 + 1 ; return $1 / $2 }")
    expect(sourceShape(after)).toBe("( $0 ) => { const $1 = $0 * 2 ; const $2 = $0 + 1 ; return $2 / $1 }")
  })

  it("sees a changed literal, and every other change but names", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["v => v + 1", "v => v + 2"],
      ["v => v + 1", "v => v - 1"],
      ["v => v.trim()", "v => v.trim().toLowerCase()"],
      ["(a, b) => a(b)", "(a, b) => a(b, b)"],
      ["v => /a/.test(v)", "v => /b/.test(v)"],
      ["v => { if (v) /^allow/.test(v.name) || v.reject() }", "v => { if (v) /^deny/.test(v.name) || v.reject() }"],
      ["v => { while (v) /a+/.exec(v) }", "v => { while (v) /b+/.exec(v) }"],
      ["v => { for (;;) /x/.test(v) }", "v => { for (;;) /y/.test(v) }"],
      ["v => { if (v) /foo/g.test(v) }", "v => { if (v) /foo/i.test(v) }"],
      ["v => `a${v}`", "v => `b${v}`"],
      ["v => v === null", "v => v === undefined"],
      ["v => { for (const k in v) f(k) }", "v => { for (const k of v) f(k) }"],
      ["v => this.a", "v => this.#a"],
      ["v => ({ answer: v })", "v => ({ result: v })"],
      ["e => t => e + t", "e => t => t + t"]
    ]
    for (const [before, after] of pairs) {
      expect(sourceShape(before), `${before} -> ${after}`).not.toBe(sourceShape(after))
    }
  })

  it("cannot tell which outer binding a name reads, beyond the pattern of its reads", () => {
    // A minifier may give two outer bindings each other's names. Stated so a
    // change to it is a decision.
    expect(sourceShape("() => f(a, b)")).toBe(sourceShape("() => f(b, a)"))
    expect(sourceShape("() => f(a, a)")).not.toBe(sourceShape("() => f(a, b)"))
  })
})

describe("sourceShape: bindings and scopes", () => {
  it("resolves a use through the scopes it is read in", () => {
    expect(sourceShape("t => t => t")).toBe("$0 => $1 => $1")
    expect(sourceShape("() => { let a = 1; { let a = 2; f(a) } return a }")).toBe(
      "( ) => { let $0 = 1 ; { let $1 = 2 ; $f0 ( $1 ) } return $0 }"
    )
    expect(sourceShape("e => { if (e) { let t = 1 } else { let t = 2 } return t }")).toBe(
      "$0 => { if ( $0 ) { let $1 = 1 } else { let $2 = 2 } return $f0 }"
    )
  })

  it("hoists var and function declarations to where they are visible", () => {
    expect(sourceShape("() => { x(); var x = 1; { var y = x } return y }")).toBe(
      "( ) => { $0 ( ) ; var $0 = 1 ; { var $1 = $0 } return $1 }"
    )
    expect(sourceShape("function f(a) { return f(a - 1) + g }")).toBe(
      "function $0 ( $1 ) { return $0 ( $1 - 1 ) + $f0 }"
    )
    expect(sourceShape("function (a) { function g(b) { return a + b } return g }")).toBe(
      "function ( $0 ) { function $1 ( $2 ) { return $0 + $2 } return $1 }"
    )
    expect(sourceShape("e => { if (e) function g() {} }")).toBe("$0 => { if ( $0 ) function $1 ( ) { } }")
    expect(sourceShape("e => { switch (e) { case 1: function g() {} } return g }")).toBe(
      "$0 => { switch ( $0 ) { case 1 : function $1 ( ) { } } return $f0 }"
    )
    // A parameter and a var of one name are one binding.
    expect(sourceShape("function (a) { var a = 1; return a }")).toBe("function ( $0 ) { var $0 = 1 ; return $0 }")
  })

  it("binds a function or class expression's own name inside it", () => {
    expect(sourceShape("function (a) { const g = function h(b) { return h(b) }; return g }")).toBe(
      "function ( $0 ) { const $1 = function $3 ( $2 ) { return $3 ( $2 ) } ; return $1 }"
    )
    expect(sourceShape("() => { const C = class D { m() { return D } }; return C }")).toBe(
      "( ) => { const $0 = class $1 { m ( ) { return $1 } } ; return $0 }"
    )
    expect(sourceShape("() => { class A {} return new A }")).toBe("( ) => { class $0 { } return new $0 }")
    expect(sourceShape("e => e ? 1 : function g() { return g }")).toBe("$0 => $0 ? 1 : function $1 ( ) { return $1 }")
  })

  it("keeps async and generator markers and reads async as a name elsewhere", () => {
    expect(sourceShape("async function* f(a) { yield await a }")).toBe("async function * $0 ( $1 ) { yield await $1 }")
    expect(sourceShape("e => { async\nfunction f() {} }")).toBe("$0 => { $f0 ; function $1 ( ) { } }")
    expect(sourceShape("async (a) => a")).toBe("async ( $0 ) => $0")
    expect(sourceShape("async a => a")).toBe("async $0 => $0")
    expect(sourceShape("x => async(x)")).toBe("$0 => $f0 ( $0 )")
    expect(sourceShape("e => function () {}")).toBe("$0 => function ( ) { }")
  })

  it("declares every name a parameter or declaration pattern binds", () => {
    expect(sourceShape("({ a, b: [c, d = 1, ...e], ...f }, [g, , h] = [], ...i) => [a, c, d, e, f, g, h, i]")).toBe(
      "( { a : $0 , b : [ $1 , $2 = 1 , ... $3 ] , ... $4 } , [ $5 , , $6 ] = [ ] , ... $7 ) => [ $0 , $1 , $2 , $3 , $4 , $5 , $6 , $7 ]"
    )
    expect(sourceShape("(a, b = a) => b")).toBe("( $0 , $1 = $0 ) => $1")
    expect(sourceShape("e => { const { [e]: a, 'b': b, c = e } = e, [d] = e; let f; return [a, b, c, d, f] }")).toBe(
      "$0 => { const { [ $0 ] : $1 , 'b' : $2 , c : $3 = $0 } = $0 , [ $4 ] = $0 ; let $5 ; return [ $1 , $2 , $3 , $4 , $5 ] }"
    )
    expect(sourceShape("e => { const { [e] } = e }")).toBe("$0 => { const { [ $0 ] } = $0 }")
  })

  it("scopes a catch parameter to its clause", () => {
    expect(sourceShape("e => { try { f(e) } catch (t) { g(t, e) } finally { h() } }")).toBe(
      "$0 => { try { $f0 ( $0 ) } catch ( $1 ) { $f1 ( $1 , $0 ) } finally { $f2 ( ) } }"
    )
    expect(sourceShape("e => { try { f(e) } catch { g(e) } }")).toBe(
      "$0 => { try { $f0 ( $0 ) } catch { $f1 ( $0 ) } }"
    )
  })

  it("scopes a let or const for head to the loop's statement", () => {
    expect(sourceShape("e => { for (let t = 0; t < e; t++) f(t); return t }")).toBe(
      "$0 => { for ( let $1 = 0 ; $1 < $0 ; $1 ++ ) $f0 ( $1 ) ; return $f1 }"
    )
    expect(sourceShape("e => { for (const [k, v] of e) f(k, v); for (var i in e) g(i) }")).toBe(
      "$0 => { for ( const [ $1 , $2 ] of $0 ) $f0 ( $1 , $2 ) ; for ( var $3 in $0 ) $f1 ( $3 ) }"
    )
    // The loop's statement ends where each kind of statement does.
    const bodies: ReadonlyArray<readonly [string, string]> = [
      ["if (t) f(t); else g(t);", "if ( $1 ) $f0 ( $1 ) ; else $f1 ( $1 ) ;"],
      ["if (t) f(t);", "if ( $1 ) $f0 ( $1 ) ;"],
      ["while (t) { t-- }", "while ( $1 ) { $1 -- }"],
      ["with (t) f(t);", "with ( $1 ) $f0 ( $1 ) ;"],
      ["do t--; while (t);", "do $1 -- ; while ( $1 ) ;"],
      ["do t--; while (t)", "do $1 -- ; while ( $1 )"],
      [
        "try { f(t) } catch (u) { g(u) } finally { h(t) }",
        "try { $f0 ( $1 ) } catch ( $2 ) { $f1 ( $2 ) } finally { $f2 ( $1 ) }"
      ],
      ["try { f(t) } catch { g(t) }", "try { $f0 ( $1 ) } catch { $f1 ( $1 ) }"],
      ["switch (t) { case 1: f(t) }", "switch ( $1 ) { case 1 : $f0 ( $1 ) }"],
      ["b: f(t);", "$l0 : $f0 ( $1 ) ;"],
      ["{ f(t) }", "{ $f0 ( $1 ) }"],
      [";", ";"],
      ["for (;;) f(t);", "for ( ; ; ) $f0 ( $1 ) ;"],
      ["for await (const u of t) f(u);", "for await ( const $2 of $1 ) $f0 ( $2 ) ;"],
      ["try { f(t) } finally { g(t) }", "try { $f0 ( $1 ) } finally { $f1 ( $1 ) }"]
    ]
    for (const [body, shape] of bodies) {
      const after = sourceShape(`e => { for (let t of e) ${body} return t }`)
      expect(after, body).toBe(`$0 => { for ( let $1 of $0 ) ${shape} return $f${shape.split("$f").length - 1} }`)
    }
    expect(sourceShape("e => { for (let t of e) f(t) }")).toBe("$0 => { for ( let $1 of $0 ) $f0 ( $1 ) }")
    expect(sourceShape("e => { for await (const t of e) f(t); return t }")).toBe(
      "$0 => { for await ( const $1 of $0 ) $f0 ( $1 ) ; return $f1 }"
    )
  })

  it("reads of as the for-of keyword only after the head's target", () => {
    expect(sourceShape("e => { for (const of of e) f(of) }")).toBe("$0 => { for ( const $1 of $0 ) $f0 ( $1 ) }")
    expect(sourceShape("e => { for (x of e) f(x) }")).toBe("$0 => { for ( $f0 of $0 ) $f1 ( $f0 ) }")
    expect(sourceShape("e => { for (const k in of) f(k) }")).toBe("$0 => { for ( const $1 in $f0 ) $f1 ( $1 ) }")
  })

  it("numbers labels apart from bindings", () => {
    expect(sourceShape("e => { a: for (;;) { if (e) break a; continue a } }")).toBe(
      "$0 => { $l0 : for ( ; ; ) { if ( $0 ) break $l0 ; continue $l0 } }"
    )
    expect(sourceShape("e => { a: { break a } }")).toBe("$0 => { $l0 : { break $l0 } }")
    expect(sourceShape("e => { for (;;) { break\ne } }")).toBe("$0 => { for ( ; ; ) { break ; $0 } }")
    expect(sourceShape("e => { for (;;) { break } }")).toBe("$0 => { for ( ; ; ) { break } }")
  })

  it("scopes every kind of method's parameters to the method", () => {
    expect(
      sourceShape(
        "() => ({ m(a) { return a }, get x() { return 1 }, set x(v) { y = v }, [k](a) { return a }, async *n(b) {} })"
      )
    ).toBe(
      "( ) => ( { m ( $0 ) { return $0 } , get x ( ) { return 1 } , set x ( $1 ) { $f0 = $1 } , [ $f1 ] ( $2 ) { return $2 } , async * n ( $3 ) { } } )"
    )
    expect(sourceShape("() => ({ 'm'(a) { return a }, 1(b) { return b } })")).toBe(
      "( ) => ( { 'm' ( $0 ) { return $0 } , 1 ( $1 ) { return $1 } } )"
    )
    expect(
      sourceShape(
        "() => class A extends B { constructor(a) { super(a) } static s(b) { return A } [k](c) {} #p(d) { return this.#p } }"
      )
    ).toBe(
      "( ) => class $0 extends $f0 { constructor ( $1 ) { super ( $1 ) } static s ( $2 ) { return $0 } [ $f1 ] ( $3 ) { } #0 ( $4 ) { return this . #0 } }"
    )
  })
})

describe("sourceShape: tokens", () => {
  it("keeps literals, keywords, operators and property names", () => {
    expect(sourceShape("function (e) { return this.step * e }")).toBe("function ( $0 ) { return this . step * $0 }")
    expect(sourceShape("x => x?.answer ?? 'none'")).toBe("$0 => $0 ?. answer ?? 'none'")
  })

  it("writes a shorthand member the way a minifier expands it", () => {
    expect(sourceShape("({ answerId }) => ({ answerId, until })")).toBe(
      sourceShape("({answerId:a})=>({answerId:a,until:b})")
    )
    expect(sourceShape("({ a = 1, b }) => a")).toBe("( { a : $0 = 1 , b : $1 } ) => $0")
  })

  it("keeps object keys, method names and property names", () => {
    expect(sourceShape("x => ({ f(y) { return y }, 'k': 1, 2: x, [x]: 3, ...x })")).toBe(
      "$0 => ( { f ( $1 ) { return $1 } , 'k' : 1 , 2 : $0 , [ $0 ] : 3 , ... $0 } )"
    )
    // Reserved words are keys and property names too.
    expect(sourceShape("x => ({ default: x.new, class: 1 })")).toBe("$0 => ( { default : $0 . new , class : 1 } )")
  })

  it("keeps accessor, async and generator members and their modifiers", () => {
    expect(sourceShape("() => ({ get a() { return 1 }, set [k](v) {}, async *g() {}, get: 1, set })")).toBe(
      "( ) => ( { get a ( ) { return 1 } , set [ $f0 ] ( $0 ) { } , async * g ( ) { } , get : 1 , set : $f1 } )"
    )
  })

  it("keeps class member names and numbers private names", () => {
    expect(
      sourceShape(
        "() => class A extends f({}) { static x = 1; #y = 2; static { go() } get z() { return this.#y } m(a) { return a } }"
      )
    ).toBe(
      "( ) => class $0 extends $f0 ( { } ) { static x = 1 ; #0 = 2 ; static { $f1 ( ) } get z ( ) { return this . #0 } m ( $1 ) { return $1 } }"
    )
    expect(sourceShape("() => class { static #p() {} }")).toBe("( ) => class { static #0 ( ) { } }")
  })

  it("keeps a class field name that follows a line break instead of `;`", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["() => class { retries = 1\n timeout = 2 }", "() => class { retries = 1\n attempts = 2 }"],
      ["() => class { a\n b }", "() => class { a\n c }"],
      ["() => class { a = () => 1\n b = 2 }", "() => class { a = () => 1\n c = 2 }"],
      ["() => class { a = {}\n b = 2 }", "() => class { a = {}\n c = 2 }"],
      // A reserved word as a property name or a key ends the field too.
      ["() => class { a = x.default\n b = 2 }", "() => class { a = x.default\n c = 2 }"],
      ["() => class { delete\n b = 2 }", "() => class { delete\n c = 2 }"],
      ["() => class { static new\n b }", "() => class { static new\n c }"],
      // An arrow function's parameter is not in scope past its field.
      ["x => class { a = x => x\n b = x }", "x => class { a = y => y\n b = y }"],
      // A class head's `extends` after a line break is no member.
      [
        "() => class { a = class D\n extends B { m() { return D } } }",
        "() => class { a = class D\n extends B { m() { return E } } }"
      ]
    ]
    for (const [before, after] of pairs) expect(sourceShape(before)).not.toBe(sourceShape(after))
    // The unbundled layout reads as the minified one, whose `;` ends each field.
    expect(sourceShape("() => class { retries = 1\n timeout = 2 }")).toBe(
      sourceShape("()=>class{retries=1;timeout=2}")
    )
    expect(sourceShape("x => class { a = y => y\n b = x }")).toBe(sourceShape("x=>class{a=y=>y;b=x}"))
    expect(sourceShape("() => class { a = async\n b = 2 }")).toBe(sourceShape("()=>class{a=async;b=2}"))
    expect(sourceShape("() => class { a = 1\n #b = 2\n 'c' = 3\n static d\n async m(x) { return x } }")).toBe(
      "( ) => class { a = 1 ; #0 = 2 ; 'c' = 3 ; static d ; async m ( $0 ) { return $0 } }"
    )
    // A line break before an operator, a bracket or `in` continues the field.
    expect(sourceShape("() => class { a = b\n [c]\n d = e\n in f }")).toBe(
      "( ) => class { a = $f0 [ $f1 ] ; d = $f2 in $f3 }"
    )
  })

  it("tells an object from a block by what comes before the brace", () => {
    // A block after `=>`, `)`, a statement, `else` and a statement colon; an
    // object after an operator, a declaration keyword, a key or a conditional.
    expect(sourceShape("e => { if (e) { a: 1 } else { b } switch (e) { case 1: { c } default: d } }")).toBe(
      "$0 => { if ( $0 ) { $l0 : 1 } else { $f0 } switch ( $0 ) { case 1 : { $f1 } default : $f2 } }"
    )
    expect(sourceShape("e => { const { a } = e; return e ? { b } : { c } }")).toBe(
      "$0 => { const { a : $1 } = $0 ; return $0 ? { b : $f0 } : { c : $f1 } }"
    )
    expect(sourceShape("e => ({ a: e ? 1 : 2, b: { c } })")).toBe("$0 => ( { a : $0 ? 1 : 2 , b : { c : $f0 } } )")
    // Source that starts with a brace starts with a block.
    expect(sourceShape("{ a }")).toBe("{ $f0 }")
    // A brace after a literal or a name is a block: the statement before it ended.
    expect(sourceShape("e => { 1\n{ a } x\n{ b } }")).toBe("$0 => { 1 { $f0 } $f1 { $f2 } }")
  })

  it("keeps template text and renames inside substitutions", () => {
    expect(sourceShape("e => `a${e ? { k: 1 } : f}b${`c${e}`}d`")).toBe(
      "$0 => `a${ $0 ? { k : 1 } : $f0 }b${ `c${ $0 }` }d`"
    )
    // A brace that opens a substitution's expression is an object.
    expect(sourceShape("e => `${{ k: e }}`")).toBe("$0 => `${ { k : $0 } }`")
    // A brace after a closed template starts a block.
    expect(sourceShape("e => { `a`\n{ x } }")).toBe("$0 => { `a` { $f0 } }")
    expect(sourceShape("e => `a\\${e}`")).toBe("$0 => `a\\${e}`")
    // An arrow's expression body ends where its substitution does.
    expect(sourceShape("e => `${t => t}${t}`")).toBe("$0 => `${ $1 => $1 }${ $f0 }`")
  })

  it("reads `/` as a regular expression only where an operand cannot end", () => {
    expect(sourceShape("e => e / 2 / f")).toBe("$0 => $0 / 2 / $f0")
    expect(sourceShape("e => /a\\/[/]b/gi.test(e)")).toBe("$0 => /a\\/[/]b/gi . test ( $0 )")
    expect(sourceShape("e => { return /x/ }")).toBe("$0 => { return /x/ }")
    expect(sourceShape("e => (e) / (2) + e[0] / 3 + e++ / 4 + this / 5")).toBe(
      "$0 => ( $0 ) / ( 2 ) + $0 [ 0 ] / 3 + $0 ++ / 4 + this / 5"
    )
    expect(sourceShape("e => `${/x/}` / 2")).toBe("$0 => `${ /x/ }` / 2")
    expect(sourceShape("e => 'a' / 2")).toBe("$0 => 'a' / 2")
    expect(sourceShape("e => { if (e) {} /y/.test(e) }")).toBe("$0 => { if ( $0 ) { } /y/ . test ( $0 ) }")
    // A `/` that cannot close on its line divides.
    expect(sourceShape("e => [1,\n/ 2\n]")).toBe("$0 => [ 1 , / 2 ]")
    expect(sourceShape("/x")).toBe("/ $f0")
  })

  it("keeps a regex after a statement head, including nested parentheses and comments", () => {
    for (
      const head of [
        "if (v)",
        "if ((ready(v)))",
        "if (/[(]/.test(v))",
        "while (ready(v))",
        "for (;;)",
        "for (const x of v)",
        "for await (const x of v)",
        "for /* head */ await /* iterable */ (const x of v)",
        "with (v)",
        "do {} while (v)\n"
      ]
    ) {
      const source = `async v => { ${head} /a[()/]b\\/c/gi.test(v) }`
      // Parse real JavaScript without executing the loop or reading its free names.
      const callback = Function(`return ${source}`)() as () => unknown
      expect(sourceShape(callback.toString()), head).toContain("/a[()/]b\\/c/gi . test")
      const changed = Function(`return ${source.replace("a[()/]b", "x[()/]y")}`)() as () => unknown
      expect(functionIdentity(callback).resumeDigest, head).not.toBe(functionIdentity(changed).resumeDigest)
      const flags = Function(`return ${source.replace("/gi.test", "/g.test")}`)() as () => unknown
      expect(functionIdentity(callback).resumeDigest, head).not.toBe(functionIdentity(flags).resumeDigest)
    }
  })

  it("keeps division after calls whose property names are statement keywords", () => {
    expect(sourceShape("v => { if (v) (v) / divisor / v }")).toBe(
      "$0 => { if ( $0 ) ( $0 ) / $f0 / $0 }"
    )
    expect(sourceShape("async v => (await(v)) / divisor / v")).toBe(
      "async $0 => ( await ( $0 ) ) / $f0 / $0"
    )
    expect(sourceShape("async v => { v.for\nawait(v) / divisor / v }")).toBe(
      "async $0 => { $0 . for await ( $0 ) / $f0 / $0 }"
    )
    for (const keyword of ["if", "while", "for", "with"]) {
      for (const access of [".", "?."]) {
        expect(sourceShape(`v => v${access}${keyword}(v) / divisor / v`)).toBe(
          `$0 => $0 ${access} ${keyword} ( $0 ) / $f0 / $0`
        )
        expect(sourceShape(`v => { if (v${access}${keyword}(v) / divisor / v) /x/.test(v) }`)).toContain(
          `if ( $0 ${access} ${keyword} ( $0 ) / $f0 / $0 ) /x/ . test`
        )
      }
    }
  })

  it("preserves regex identity under pattern mutations and binding renames after statement heads", () => {
    const pattern = FastCheck.array(FastCheck.constantFrom("a", "b", "c", "x", "y", "z"), {
      minLength: 1,
      maxLength: 20
    }).map((letters) => letters.join(""))
    FastCheck.assert(
      FastCheck.property(
        FastCheck.uniqueArray(pattern, { minLength: 2, maxLength: 2 }),
        FastCheck.constantFrom("if (v)", "while (v)", "for (; v;)", "for await (const x of v)", "with (v)"),
        FastCheck.constantFrom("", "g", "i", "gi", "u"),
        FastCheck.constantFrom(" ", "\n", "/* gap */"),
        FastCheck.integer({ min: 0, max: 5 }),
        ([before, after], head, flags, gap, depth) => {
          const nested = head.replaceAll(/\bv\b/g, `${"(".repeat(depth)}v${")".repeat(depth)}`)
          const source = `async v => { ${nested}${gap}/^${before}+/${flags}.test(v) }`
          const changed = source.replace(`/^${before}+/`, `/^${after}+/`)
          expect(sourceShape(source)).toContain(`/^${before}+/${flags}`)
          expect(sourceShape(source)).not.toBe(sourceShape(changed))
          expect(sourceShape(source)).toBe(sourceShape(source.replaceAll(/\bv\b/g, "renamed")))
        }
      ),
      {
        numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
        ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) })
      }
    )
  })

  it("reads every form of number", () => {
    expect(sourceShape("() => [0x1F, 0b10n, 0o7, 1_000, .5, 5., 1e-7, 2E+3, 3e8, 10n, 1..toString(), a?.5:1]")).toBe(
      "( ) => [ 0x1F , 0b10n , 0o7 , 1_000 , .5 , 5. , 1e-7 , 2E+3 , 3e8 , 10n , 1. . toString ( ) , $f0 ? .5 : 1 ]"
    )
    expect(sourceShape("() => 0")).toBe("( ) => 0")
  })

  it("drops comments and whitespace, keeping only a line break that ends a statement", () => {
    expect(sourceShape("e => {\n  // a comment\n  return /* inline */ e\t+\u00a01\n}")).toBe("$0 => { return $0 + 1 }")
    // After return, break, continue, throw, yield or async, a line break ends the statement.
    expect(sourceShape("() => {\n return\n 1 }")).toBe("( ) => { return ; 1 }")
    expect(sourceShape("() => {\n return 1 }")).toBe("( ) => { return 1 }")
    expect(sourceShape("e => { return /*\n*/ e }")).toBe("$0 => { return ; $0 }")
    // Before ++ or --, it ends the statement only after an operand.
    expect(sourceShape("e => { e\n++f }")).toBe("$0 => { $0 ; ++ $f0 }")
    expect(sourceShape("e => { e++\nf }")).toBe("$0 => { $0 ++ $f0 }")
    expect(sourceShape("e => [e,\n--f]")).toBe("$0 => [ $0 , -- $f0 ]")
    expect(sourceShape("e => { if (e)\n--e; e[0]\n--e; 'a'\n++e; `b`\n--e; this\n++e; e++\n++e; {}\n++e }")).toBe(
      "$0 => { if ( $0 ) -- $0 ; $0 [ 0 ] ; -- $0 ; 'a' ; ++ $0 ; `b` ; -- $0 ; this ; ++ $0 ; $0 ++ ; ++ $0 ; { } ; ++ $0 }"
    )
    expect(sourceShape("e => { return\n++e; f(`a${\n++e}`) }")).toBe("$0 => { return ; ++ $0 ; $f0 ( `a${ ++ $0 }` ) }")
    expect(sourceShape("e => {\u2028return\u2029e\r\n}")).toBe("$0 => { return ; $0 }")
  })

  it("renames names in every alphabet and keeps a string's text exactly", () => {
    expect(sourceShape("(été, 𝑥) => été + 𝑥 + 'é  𝑥'")).toBe("( $0 , $1 ) => $0 + $1 + 'é  𝑥'")
    expect(sourceShape("(\\u0061) => \\u0061")).toBe("( $0 ) => $0")
    expect(sourceShape("e => \"a\\\"b\" + 'c'")).toBe("$0 => \"a\\\"b\" + 'c'")
  })

  it("never throws on source no parser would accept", () => {
    for (
      const source of [
        "\"open",
        "'a\\",
        "`open",
        "`a${",
        "/* open",
        "#",
        "#1",
        ")]}",
        "`a${)}`b`",
        "\\",
        "a\ud800b",
        "function",
        "function f",
        "function () ",
        "class",
        "class A",
        "catch (",
        "do",
        "do x",
        "do {} while",
        "do {} while (",
        "do {} while [x]",
        "do {} while (]",
        "for",
        "for (let",
        "let",
        "const {",
        "const [a",
        "(a) =>",
        "a =>",
        "({ m(",
        "e => { for (let t of e) if (t)",
        "e => { for (let t of e) do",
        "e => { for (let t of e) try {} catch",
        "e => { for (let t of e) switch"
      ]
    ) {
      expect(typeof sourceShape(source), source).toBe("string")
    }
    expect(sourceShape(")]}`")).toBe(") ] } `")
    // What cannot be a binding is not declared.
    expect(sourceShape("const this = 1")).toBe("const this = 1")
    expect(sourceShape("const 1 = e")).toBe("const 1 = $f0")
  })

  it("stops following nested statements past a bound, still renaming every token", () => {
    const nested = `${"if (t) ".repeat(300)}f(t)`
    expect(sourceShape(`e => { for (let t of e) ${nested}; return t }`)).toContain("return $1 }")
  })
})

describe("sourceShape: prefix updates after statement heads", () => {
  it.each(["++", "--"])("distinguishes conditional %s from an empty if body", (operator) => {
    const conditional = Function(`return (v, x) => { if (v)\n${operator}x; return x }`)() as (
      v: boolean,
      x: number
    ) => number
    const unconditional = Function(`return (v, x) => { if (v);\n${operator}x; return x }`)() as typeof conditional
    expect(conditional(false, 0)).toBe(0)
    expect(unconditional(false, 0)).toBe(operator === "++" ? 1 : -1)
    expect(conditional(true, 0)).toBe(unconditional(true, 0))
    expect(sourceShape(conditional.toString())).not.toBe(sourceShape(unconditional.toString()))
    expect(functionIdentity(conditional).resumeDigest).not.toBe(functionIdentity(unconditional).resumeDigest)
  })

  it.each([
    "if (v)",
    "if ((Boolean(v)))",
    "if (v) if (v)",
    "if (v) while ((v))",
    "while (v) if ((v))",
    "do ; while (v) while (v)",
    "do x\nwhile (v)\nwhile (v)",
    "do if (v) x++\nwhile (v) x++\nwhile (v)",
    "for (; v;)",
    "for (const item of v)",
    "for await (const item of v)",
    "for /* head */ await /* iterable */ (const item of v)",
    "with (v)"
  ])("keeps the prefix update as the body of %s", (head) => {
    for (const operator of ["++", "--"]) {
      for (const gap of ["\n", "\r\n", "\u2028", "\u2029", "/*\n*/", "// gap\n"]) {
        const source = `async (v, x) => { ${head}${gap}${operator}x; return x }`
        const inline = `async (v, x) => { ${head} ${operator}x; return x }`
        const empty = `async (v, x) => { ${head};${gap}${operator}x; return x }`
        // Parse the real callbacks without executing loops or reading free names.
        const callback = Function(`return ${source}`)() as () => unknown
        const changed = Function(`return ${empty}`)() as () => unknown
        expect(sourceShape(callback.toString())).toBe(sourceShape(inline))
        expect(sourceShape(callback.toString())).not.toBe(sourceShape(changed.toString()))
        expect(functionIdentity(callback).resumeDigest).not.toBe(functionIdentity(changed).resumeDigest)
      }
    }
  })

  it.each([
    "x",
    "(x)",
    "Number(x)",
    "v[0]",
    "v.if(x)",
    "v?.if(x)",
    "v.while(x)",
    "v?.for(x)",
    "v.with(x)"
  ])("retains the operand ASI boundary after %s", (operand) => {
    for (const operator of ["++", "--"]) {
      const source = `(v, x) => { ${operand}\n${operator}x; return x }`
      const explicit = `(v, x) => { ${operand};\n${operator}x; return x }`
      const callback = Function(`return ${source}`)() as () => unknown
      const equivalent = Function(`return ${explicit}`)() as () => unknown
      expect(sourceShape(callback.toString())).toBe(sourceShape(equivalent.toString()))
      expect(functionIdentity(callback).resumeDigest).toBe(functionIdentity(equivalent).resumeDigest)
    }
  })

  it.each([
    "do {} while (v)",
    "do ; while (v)",
    "do x++; while (v)",
    "do x++\nwhile (v)",
    "do if (v) x++\nwhile (v)",
    "do if (v) x++\nelse x--\nwhile (v)",
    "do if (v) x++\nelse while (v) x--\nwhile (v)",
    "do while (v) x++\nwhile (v)",
    "do for (; v;) x++\nwhile (v)",
    "do label: if (v) x++\nwhile (v)",
    "do do x++\nwhile (v)\nwhile (v)",
    "do do {} while (v); while (v)",
    "do x.while(v)\nwhile (v)",
    "do x?.while(v)\nwhile (v)",
    "do x.else(v)\nwhile (v)",
    "do x?.else(v)\nwhile (v)"
  ])("retains ASI after the do-while tail in %s", (body) => {
    for (const operator of ["++", "--"]) {
      for (const gap of ["\n", "/*\n*/"]) {
        const source = `(v, x) => { ${body}${gap}${operator}x; return x }`
        const explicit = `(v, x) => { ${body};${gap}${operator}x; return x }`
        const callback = Function(`return ${source}`)() as () => unknown
        const equivalent = Function(`return ${explicit}`)() as () => unknown
        expect(sourceShape(callback.toString())).toBe(sourceShape(equivalent.toString()))
        expect(functionIdentity(callback).resumeDigest).toBe(functionIdentity(equivalent).resumeDigest)
      }
    }
  })

  it.each([255, 256, 257, 258, 1024])("retains do-while tail ASI after %s nested statement heads", (depth) => {
    for (const operator of ["++", "--"]) {
      const body = `do ${"if (v) ".repeat(depth)}x++; while (v)`
      const source = `(v, x) => { ${body}\n${operator}x; return x }`
      const explicit = `(v, x) => { ${body};\n${operator}x; return x }`
      const callback = Function(`return ${source}`)() as (v: boolean, x: number) => number
      const equivalent = Function(`return ${explicit}`)() as typeof callback
      expect(callback(false, 0)).toBe(equivalent(false, 0))
      expect(sourceShape(callback.toString())).toBe(sourceShape(equivalent.toString()))
      expect(functionIdentity(callback).resumeDigest).toBe(functionIdentity(equivalent).resumeDigest)
    }
  })

  it("preserves implicit do-while semicolons under generated nested statements", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.constantFrom("++", "--"),
        FastCheck.constantFrom("\n", "\r\n", "\u2028", "\u2029", "/*\n*/", "// gap\n"),
        FastCheck.array(FastCheck.constantFrom("if", "while", "for", "do", "block"), { maxLength: 8 }),
        (operator, gap, wrappers) => {
          let body = `x${operator}`
          for (const wrapper of wrappers) {
            if (wrapper === "do") body = `do ${body}${gap}while (v)`
            else if (wrapper === "block") body = `{ ${body} }`
            else body = `${wrapper === "for" ? "for (; v;)" : `${wrapper} (v)`}${gap}${body}`
          }
          const source = `(v, x) => { do ${body}${gap}while (v)${gap}${operator}x; return x }`
          const explicit = `(v, x) => { do ${body}${gap}while (v);${gap}${operator}x; return x }`
          const callback = Function(`return ${source}`)() as (v: boolean, x: number) => number
          const equivalent = Function(`return ${explicit}`)() as typeof callback
          expect(callback(false, 0)).toBe(equivalent(false, 0))
          expect(sourceShape(callback.toString())).toBe(sourceShape(equivalent.toString()))
          expect(functionIdentity(callback).resumeDigest).toBe(functionIdentity(equivalent).resumeDigest)
        }
      ),
      {
        numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
        ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) })
      }
    )
  })

  it("preserves conditional update behavior under nested heads, line breaks and binding renames", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.constantFrom("++", "--"),
        FastCheck.constantFrom("\n", "\r\n", "\u2028", "\u2029", "/*\n*/", "// gap\n"),
        FastCheck.integer({ min: 1, max: 8 }),
        FastCheck.integer({ min: 0, max: 5 }),
        FastCheck.integer({ min: -1000, max: 1000 }),
        (operator, gap, heads, depth, initial) => {
          const head = `if (${"(".repeat(depth)}v${")".repeat(depth)}) `.repeat(heads).trimEnd()
          const source = `(v, x) => { ${head}${gap}${operator}x; return x }`
          const empty = `(v, x) => { ${head};${gap}${operator}x; return x }`
          const conditional = Function(`return ${source}`)() as (v: boolean, x: number) => number
          const unconditional = Function(`return ${empty}`)() as typeof conditional
          expect(conditional(false, initial)).toBe(initial)
          expect(unconditional(false, initial)).toBe(initial + (operator === "++" ? 1 : -1))
          expect(sourceShape(source)).not.toBe(sourceShape(empty))
          expect(functionIdentity(conditional).resumeDigest).not.toBe(functionIdentity(unconditional).resumeDigest)
          expect(sourceShape(source)).toBe(
            sourceShape(source.replaceAll(/\bv\b/g, "ready").replaceAll(/\bx\b/g, "value"))
          )
        }
      ),
      {
        numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
        ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) })
      }
    )
  })
})

describe("functionIdentity's resume digest", () => {
  it("is the digest of the shape, joined to the captures for a captured function", () => {
    const one = functionIdentity((value: number) => value + 1)
    const minified = functionIdentity(Function("return (e)=>e+1")() as (value: number) => number)
    expect(one.resumeDigest).toBe(minified.resumeDigest)
    expect(one.digest).not.toBe(minified.digest)
  })

  it("reads a shape from its cache and starts the cache over past its bound", () => {
    const source = (index: number) => Function(`return (e)=>e+${index}`)() as (value: number) => number
    const first = functionIdentity(source(0)).resumeDigest
    // More distinct sources than the cache holds, then the first again.
    for (let index = 1; index <= 1100; index++) functionIdentity(source(index))
    expect(functionIdentity(source(0)).resumeDigest).toBe(first)
    expect(functionIdentity(source(0)).resumeDigest).toBe(first)
  })
})

/**
 * Code beside the library in a later build: more of the library and code of
 * its own. Its bindings change how often each name is used across the bundle,
 * so the minifier hands the library's bindings other names.
 */
const unrelated = [
  `export * as Arr from "effect/Array"`,
  `export * as Schedule from "effect/Schedule"`,
  ...Array.from(
    { length: 120 },
    (_, index) =>
      `export const pad${index} = (alpha, beta) => { const gamma = alpha * beta + ${index}; return [gamma, alpha, beta].map((x) => x + gamma) }`
  )
].join("\n")

/** Every function a module namespace reaches, by the path it is reached at. */
const functions = (root: Record<string, unknown>): Map<string, string> => {
  const found = new Map<string, string>()
  const seen = new Set<unknown>()
  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > 3 || value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) {
      return
    }
    seen.add(value)
    if (typeof value === "function") found.set(path, Function.prototype.toString.call(value))
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      // esbuild exports a namespace through getters: read the exported value
      // there, and nowhere else, where a getter may expect an instance.
      if ("value" in descriptor) visit(descriptor.value, `${path}.${key}`, depth + 1)
      else if (depth === 0) visit((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1)
    }
  }
  for (const key of Object.keys(root)) visit(root[key], key, 0)
  return found
}

const minifiedEffect = async (beside: string): Promise<Map<string, string>> => {
  const output = await esbuild.build({
    stdin: {
      contents: `${beside}\nexport * as Schema from "effect/Schema"\nexport * as Effect from "effect/Effect"`,
      resolveDir: import.meta.dirname,
      loader: "js"
    },
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "bundle",
    write: false,
    logLevel: "silent"
  })
  return functions(new Function(`${output.outputFiles[0]!.text};return bundle`)() as Record<string, unknown>)
}

describe("sourceShape over a real minifier", () => {
  it("keeps the shape of every function effect exports when unrelated code renames it", async () => {
    // The host's own copy, so the bundle is the library the tests already load.
    expect(Effect.Schema).toBeDefined()
    const alone = await minifiedEffect("")
    const beside = await minifiedEffect(unrelated)
    let renamed = 0
    for (const [path, source] of alone) {
      const other = beside.get(path)!
      if (other !== source) renamed++
      expect(sourceShape(other), path).toBe(sourceShape(source))
    }
    expect(alone.size).toBeGreaterThan(500)
    // The minifier really did rename most of them.
    expect(renamed).toBeGreaterThan(alone.size / 2)
  }, 60_000)
})
