import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import { Bridge, Interactions, ViewCode, ViewCsp } from "../src/index.ts"
import { comparison, components, ticTacToe } from "./fixtures/modules.ts"

const opts = { time: 120, warmupTime: 30 }

const runtimeScript = "(() => { const root = document.body; window.addEventListener('message', () => {}); })()\n".repeat(
  16
)
const stylesText = ":root { --bg: #fff; --fg: #111; } body { margin: 0; font-family: system-ui; }\n".repeat(12)
const validNonce = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"

const declaredInteractions: Interactions.Declared = {
  cell: { kind: "state" },
  again: { kind: "message", label: "Play again" },
  filter: { kind: "state" },
  export: { kind: "message", label: "Export report" }
}

const initMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: {
    nonce: validNonce,
    protocolVersion: "2026-01-26",
    appInfo: { name: "smithers-view", version: "1.0.0" }
  }
}

const interactionMessage = {
  jsonrpc: "2.0",
  method: "ui/notifications/interaction",
  params: {
    event: "cell:4",
    values: { row: 1, col: 1, active: true, label: "X" }
  }
}

describe("@smthrs/views", () => {
  test("ViewCode.check tic-tac-toe interactive TSX module", async ({ bench }) => {
    await bench("ViewCode.check (tic-tac-toe)", () => {
      Effect.runSync(ViewCode.check(ticTacToe, { components }))
    }).run(opts)
  })

  test("ViewCode.check comparison static TSX module", async ({ bench }) => {
    await bench("ViewCode.check (comparison)", () => {
      Effect.runSync(ViewCode.check(comparison, { components }))
    }).run(opts)
  })

  test("ViewCsp.frameDocument (hash + CSP + HTML)", async ({ bench }) => {
    await bench("ViewCsp.frameDocument", () => {
      ViewCsp.frameDocument({
        nonce: validNonce,
        theme: "dark",
        runtime: runtimeScript,
        styles: stylesText
      })
    }).run(opts)
  })

  test("Interactions.parse, format, and lookup", async ({ bench }) => {
    const attrs = ["cell:4", "again", "filter:open", "unknown:x"]
    await bench("Interactions parse + lookup (4)", () => {
      for (const attr of attrs) {
        const parsed = Interactions.parse(attr)
        if (parsed._tag === "Some") {
          Interactions.format(parsed.value)
          Interactions.lookup(declaredInteractions, parsed.value.name)
        }
      }
    }).run(opts)
  })

  test("Bridge.acceptInitialize + Bridge.receive", async ({ bench }) => {
    await bench("Bridge init + receive", () => {
      Bridge.acceptInitialize(initMessage, validNonce)
      Bridge.receive({
        message: interactionMessage,
        declared: declaredInteractions,
        window: [],
        now: 1_700_000_000_000
      })
    }).run(opts)
  })
})
