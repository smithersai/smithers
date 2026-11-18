#!/usr/bin/env node
// Starts Smithers build for a replay that uses a shared cache.
//
// A step runs beside Smithers build and can read what every process was
// started with, so the cache's token is in no process's environment: not this
// one's, and not that of any program Smithers build starts. It arrives on
// standard input, a pipe from smithers-ci that ends after it, and stays in
// this process's memory. Smithers build asks its environment for the token by
// name and then removes it; here that question is answered from memory, and
// the token is never among the variables a started program inherits.
//
// Usage: smthrs-with-token.mjs <the smthrs program> [its arguments]
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const name = "SMITHERS_CACHE_TOKEN"
let token = readFileSync(0, "utf8")
process.env = new Proxy(process.env, {
  get: (variables, key) => (key === name && token !== "" ? token : Reflect.get(variables, key)),
  has: (variables, key) => (key === name && token !== "") || Reflect.has(variables, key),
  // A variable is set on the real environment, which takes a whole value and nothing less.
  set: (variables, key, value) => Reflect.set(variables, key, value),
  deleteProperty: (variables, key) => {
    if (key === name) token = ""
    return Reflect.deleteProperty(variables, key)
  }
})
const [program] = process.argv.splice(2, 1)
process.argv[1] = program
await import(pathToFileURL(program).href)
