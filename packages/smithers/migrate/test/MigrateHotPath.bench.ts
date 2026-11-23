import { describe, test } from "vitest"
import * as Constructs from "../src/Constructs.ts"
import * as Detect from "../src/Detect.ts"
import * as Mapping from "../src/Mapping.ts"
import * as ZodSchemaHints from "../src/ZodSchemaHints.ts"

const zodChains = [
  `z.object({ id: z.string(), count: z.number().int().min(0), tags: z.array(z.string()).optional() })`,
  `z.enum(["pending", "running", "completed", "failed"])`,
  `z.union([z.string(), z.number(), z.boolean()])`,
  `z.record(z.string(), z.array(z.object({ path: z.string(), ok: z.boolean() })))`
]

const specifiers = [
  "smithers-orchestrator",
  "@smithers/core",
  "@smthrs/flow",
  "@smithers-ai/workflow",
  "effect/Schema",
  "smthrs/react"
]

const constructNames = [
  "Workflow",
  "Task",
  "Sequence",
  "Parallel",
  "Branch",
  "Ralph",
  "Approval",
  "createSmithers"
]

describe("migrate hot paths", () => {
  test("ZodSchemaHints.classify and print", async ({ bench }) => {
    await bench("classify + print 4 complex Zod AST chains to Effect Schema", () => {
      for (const chain of zodChains) {
        ZodSchemaHints.classify(chain)
        ZodSchemaHints.print(chain)
      }
    }).run({ iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 })
  })

  test("Detect.isOldSpecifier and classifyPackage", async ({ bench }) => {
    await bench("classify 6 import specifiers and package versions", () => {
      for (const spec of specifiers) {
        Detect.isOldSpecifier(spec)
        Detect.classifyPackage(spec, "^0.14.0")
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Constructs and Mapping catalog lookup", async ({ bench }) => {
    await bench("lookup 8 constructs across Constructs + Mapping catalogs", () => {
      for (const name of constructNames) {
        Constructs.byName(name)
        Constructs.isComponent(name)
        Mapping.byConstruct(name)
      }
    }).run({ time: 120, warmupTime: 30 })
  })
})
