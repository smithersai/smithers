// Real Yjs 13 <-> native Yrs wire test. Run with Bun after building smithers-ffi:
// YJS_MODULE=/path/to/yjs SMITHERS_FFI_LIB=/path/to/libsmithers_ffi.dylib bun smithers-ffi/tests/wiki-yjs-interop.ts
// Yjs is a test dependency; no Bun/NAPI runtime is introduced into the Go API.
import { CString, dlopen, FFIType, ptr } from "bun:ffi"
import { createRequire } from "node:module"
import { strict as assert } from "node:assert"
const require = createRequire(import.meta.url)
const Y = require(process.env.YJS_MODULE ?? "yjs")
const library = process.env.SMITHERS_FFI_LIB
assert.ok(library, "SMITHERS_FFI_LIB is required")
const native = dlopen(library, {
 smithers_wiki_document: { args: [FFIType.ptr], returns: FFIType.ptr },
 smithers_free_string: { args: [FFIType.ptr], returns: FFIType.void },
})
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64")
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64"))
function merge(input: object) {
 const encoded = Buffer.from(JSON.stringify(input)+"\0")
 const address = native.symbols.smithers_wiki_document(ptr(encoded))
 assert.ok(address)
 try { const value = JSON.parse(new CString(address).toString()); assert.equal(value.error, undefined); return value }
 finally { native.symbols.smithers_free_string(address) }
}
function document(state: string) { const doc = new Y.Doc(); Y.applyUpdate(doc, bytes(state)); return doc }
try {
 const seed = merge({operation:"seed", markdown:"Hello 🌎"})
 const a = document(seed.state), b = document(seed.state)
 const base = bytes(seed.state_vector)
 a.getText("markdown").insert(8, " from Alice")
 b.getText("markdown").insert(0, "B: ")
 const ua = b64(Y.encodeStateAsUpdate(a, base)), ub = b64(Y.encodeStateAsUpdate(b, base))
 let ab = merge({operation:"apply", state:seed.state, update:ua})
 ab = merge({operation:"apply", state:ab.state, update:ub})
 let ba = merge({operation:"apply", state:seed.state, update:ub})
 ba = merge({operation:"apply", state:ba.state, update:ua})
 assert.equal(ab.markdown, ba.markdown)
 assert.equal(ab.markdown, "B: Hello 🌎 from Alice")
 Y.applyUpdate(a, bytes(ab.state)); Y.applyUpdate(b, bytes(ba.state))
 assert.equal(a.getText("markdown").toString(), ab.markdown)
 assert.equal(b.getText("markdown").toString(), ab.markdown)
 assert.equal(merge({operation:"apply", state:ab.state, update:ua}).markdown, ab.markdown)
 const replacement = merge({operation:"replace", state:ab.state, markdown:"Replaced 🦉"})
 Y.applyUpdate(a, bytes(replacement.state)); assert.equal(a.getText("markdown").toString(), "Replaced 🦉")
 // A second delta arriving before its causal predecessor survives a native
 // serialize/reopen cycle and integrates only after that predecessor arrives.
 const c = new Y.Doc(); const empty = b64(Y.encodeStateAsUpdate(c))
 c.getText("markdown").insert(0,"A"); const u1 = b64(Y.encodeStateAsUpdate(c)); const v1 = Y.encodeStateVector(c)
 c.getText("markdown").insert(1,"B"); const u2 = b64(Y.encodeStateAsUpdate(c,v1))
 const pending = merge({operation:"apply",state:empty,update:u2})
 assert.equal(pending.markdown, "")
 assert.equal(merge({operation:"apply",state:pending.state,update:u1}).markdown,"AB")
 console.log("PASS: real Yjs 13.6.32 ↔ Yrs 0.27.4 native merge, Unicode, concurrent convergence, retries, replacement, delayed dependency")
} finally { native.close() }
