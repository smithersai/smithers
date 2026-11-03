import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, OpenApiContractAgent } from "../../../examples/use-cases/openapi-contract-agent.vibe"

const directory = mkdtempSync(join(tmpdir(), "openapi-contract-agent-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, name: string): string => new RegExp(`\\n${name}: (.+)`).exec(asked)?.[1] ?? ""

/** A two-operation spec, as the caller hands it over. */
const spec = JSON.stringify({
  openapi: "3.1.0",
  paths: {
    "/users/{id}": { get: { operationId: "getUser" } },
    "/users": { post: { operationId: "createUser" } }
  }
})

const pascal = (name: string) => name[0]!.toUpperCase() + name.slice(1)

/**
 * A parser that lists the operations in the spec content it is handed, a
 * generator that names one request and one response interface per operation
 * in the convention it is handed, and a call builder that writes one call per
 * operation signature against the base URL it is handed. Each request is
 * recorded in order. With `brokenGenerator` the generator answers off-schema.
 */
const script = (brokenGenerator = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are an OpenAPI and JSON Schema specialist")) {
      const format = /Parse this (\S+) spec/.exec(asked)?.[1]
      turns.push(`parse ${format} from ${field(asked, "Spec path")}`)
      const content: string = JSON.parse(field(asked, "Spec content"))
      const paths: Record<string, Record<string, { readonly operationId: string }>> = content === ""
        ? {}
        : JSON.parse(content).paths
      return {
        specFormat: "openapi-3.1",
        endpoints: Object.entries(paths).flatMap(([path, methods]) =>
          Object.entries(methods).map(([method, operation]) => ({
            method: method.toUpperCase(),
            path,
            operationId: operation.operationId,
            summary: operation.operationId
          }))
        ),
        sharedModels: [{ name: "User", properties: { id: { type: "string", required: true } } }]
      }
    }
    if (asked.includes("You are a TypeScript interface generator")) {
      const naming = field(asked, "Naming")
      turns.push(`generate ${naming} zod=${field(asked, "Include zod")} branded=${field(asked, "Branded IDs")}`)
      if (brokenGenerator) return { unexpected: true }
      const contract = JSON.parse(field(asked, "Contract"))
      const name = (base: string) => naming === "PascalCase" ? pascal(base) : base
      return {
        interfaces: [{
          name: name("user"),
          source: contract.sharedModels[0].name,
          fields: [{ name: "id", type: "UserId", optional: false }],
          zodSchema: "z.object({ id: z.string() })"
        }],
        operationSignatures: contract.endpoints.map((
          endpoint: { readonly operationId: string; readonly method: string; readonly path: string }
        ) => ({
          operationId: endpoint.operationId,
          method: endpoint.method,
          path: endpoint.path,
          inputType: name(`${endpoint.operationId}Request`),
          outputType: name(`${endpoint.operationId}Response`)
        })),
        summary: `${contract.endpoints.length} operations`
      }
    }
    if (asked.includes("You are a typed API call builder")) {
      const target = /Build typed calls against (\S+) with (\S+) auth\./.exec(asked)
      turns.push(`calls ${target?.[1]} ${target?.[2]}`)
      const interfaces = JSON.parse(field(asked, "Interfaces"))
      const signatures: ReadonlyArray<
        {
          readonly operationId: string
          readonly method: string
          readonly path: string
          readonly inputType: string
          readonly outputType: string
        }
      > = interfaces.operationSignatures
      return {
        calls: signatures.map((signature) => ({
          operationId: signature.operationId,
          endpoint: `${signature.method} ${target?.[1]}${signature.path}`,
          inputInterface: signature.inputType,
          outputInterface: signature.outputType,
          samplePayload: {},
          expectedShape: { id: "user_1" },
          validationNotes: []
        })),
        coverage: { totalEndpoints: signatures.length, typedEndpoints: signatures.length, warnings: [] },
        summary: "all typed"
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("types every operation in the spec with the default conventions", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(OpenApiContractAgent, { specContent: spec }, {
      filename: join(directory, "defaults.sqlite"),
      executionId: "openapi-defaults",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "parse openapi-3.1 from none",
      "generate PascalCase zod=true branded=true",
      "calls https://api.example.com bearer"
    ])
    expect(output.interfaces.operationSignatures.map((s) => s.inputType)).toEqual([
      "GetUserRequest",
      "CreateUserRequest"
    ])
    // The call builder wrote one call per signature the generator derived from the parsed spec.
    expect(output.typedCalls.calls.map((call) => [call.endpoint, call.outputInterface])).toEqual([
      ["GET https://api.example.com/users/{id}", "GetUserResponse"],
      ["POST https://api.example.com/users", "CreateUserResponse"]
    ])
    expect(output.typedCalls.coverage).toEqual({ totalEndpoints: 2, typedEndpoints: 2, warnings: [] })
  }))

it.effect("hands the caller's conventions to each step", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(
      OpenApiContractAgent,
      {
        specPath: "api/openapi.json",
        specContent: spec,
        format: "openapi-3.0",
        namingConvention: "camelCase",
        includeZod: false,
        brandedIds: false,
        baseUrl: "https://staging.internal",
        authScheme: "apiKey"
      },
      {
        filename: join(directory, "conventions.sqlite"),
        executionId: "openapi-conventions",
        script: answer,
        actions: layer
      }
    )

    expect(turns).toEqual([
      "parse openapi-3.0 from api/openapi.json",
      "generate camelCase zod=false branded=false",
      "calls https://staging.internal apiKey"
    ])
    expect(output.typedCalls.calls[0]?.inputInterface).toBe("getUserRequest")
  }))

it.effect("fails without building calls when generation fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(OpenApiContractAgent, { specContent: spec }, {
      filename: join(directory, "failed.sqlite"),
      executionId: "openapi-failed",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turns).toContain("generate PascalCase zod=true branded=true")
    expect(turns.some((turn) => turn.startsWith("calls"))).toBe(false)
  }))
