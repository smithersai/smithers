import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { stripComments } from "./effect-policy"
import { compareBridge, compareDurableObjects, compareVars } from "./adopt-durable-objects"
import type { LiveBinding } from "./adopt-durable-objects"

const live: ReadonlyArray<LiveBinding> = WORKER_IDENTITY.durableObjects.map((binding) => ({
  type: "durable_object_namespace",
  name: binding.binding,
  class_name: binding.className
}))

describe("compareDurableObjects", () => {
  test("the live script matching the declaration is all PASS", () => {
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects, live, "smithers-mvp-web")
    expect(findings.map((f) => f.level)).toEqual(WORKER_IDENTITY.durableObjects.map(() => "PASS"))
  })

  test("a live binding the declaration lacks is a deletion, so FAIL", () => {
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects.slice(1), live, "smithers-mvp-web")
    const fail = findings.find((f) => f.level === "FAIL")
    expect(fail?.detail).toContain("DELETE class TurnCancelRegistry")
  })

  test("a declared binding the live script lacks is an empty new class, so FAIL", () => {
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects, live.slice(1), "smithers-mvp-web")
    const fail = findings.find((f) => f.level === "FAIL")
    expect(fail?.detail).toContain("CREATE an empty class TurnCancelRegistry")
  })

  test("a class name that differs under the same binding name is a rename, so FAIL", () => {
    const renamed = live.map((b) => (b.name === "TURN_LIMITS" ? { ...b, class_name: "TurnLimiter" } : b))
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects, renamed, "smithers-mvp-web")
    expect(findings.find((f) => f.level === "FAIL")?.detail).toContain("RENAME")
  })

  test("a cross-script binding on the live script is not this script's class", () => {
    const foreign: LiveBinding = { type: "durable_object_namespace", name: "OTHER", class_name: "Other", script_name: "elsewhere" }
    const findings = compareDurableObjects(WORKER_IDENTITY.durableObjects, [...live, foreign], "smithers-mvp-web")
    expect(findings.every((f) => f.level === "PASS")).toBe(true)
  })
})

describe("compareVars", () => {
  const plain: ReadonlyArray<LiveBinding> = Object.entries(WORKER_IDENTITY.vars).map(([name, text]) => ({ type: "plain_text", name, text }))

  /*
   * An Alchemy upload replaces the binding set wholesale, so a live secret
   * the shell does not carry is dropped and its route answers its honest
   * 501/503 from that moment. That is an outage, so the preflight FAILS and
   * the deploy stops; retiring one on purpose is `--allow-secret-drop`.
   */
  test("a live secret absent from the shell is a FAIL naming the drop, never the value", () => {
    const findings = compareVars([...plain, { type: "secret_text", name: "CEREBRAS_API_KEY" }], {})
    const fail = findings.find((f) => f.check === "secret CEREBRAS_API_KEY")
    expect(fail?.level).toBe("FAIL")
    expect(fail?.detail).toContain("DROPS")
    expect(fail?.detail).toContain("--allow-secret-drop")
  })

  test("--allow-secret-drop downgrades that FAIL to a WARN and stops advertising itself", () => {
    const live = [...plain, { type: "secret_text", name: "CEREBRAS_API_KEY" } as const]
    const findings = compareVars(live, {}, { allowSecretDrop: true })
    const warn = findings.find((f) => f.check === "secret CEREBRAS_API_KEY")
    expect(warn?.level).toBe("WARN")
    expect(warn?.detail).toContain("DROPS")
    expect(warn?.detail).not.toContain("--allow-secret-drop")
  })

  test("a live knob absent from the shell is a FAIL too, and the flag downgrades it", () => {
    const live = [...plain, { type: "secret_text", name: "CEREBRAS_MODEL" } as const]
    expect(compareVars(live, {}).find((f) => f.check === "knob CEREBRAS_MODEL")?.level).toBe("FAIL")
    expect(compareVars(live, {}, { allowSecretDrop: true }).find((f) => f.check === "knob CEREBRAS_MODEL")?.level).toBe("WARN")
  })

  /*
   * A name outside src/workerIdentity.ts feeds nothing the Worker reads and
   * cannot be exported into a declared slot, so failing on it would make
   * every deploy pass the escape hatch — the same as having no gate.
   */
  test("an UNDECLARED live secret stays a WARN, with or without the flag", () => {
    const live = [...plain, { type: "secret_text", name: "GATEWAY_UPSTREAM_TOKEN" } as const]
    expect(compareVars(live, {}).find((f) => f.check === "live secret GATEWAY_UPSTREAM_TOKEN")?.level).toBe("WARN")
    expect(compareVars(live, {}, { allowSecretDrop: true }).find((f) => f.check === "live secret GATEWAY_UPSTREAM_TOKEN")?.level).toBe("WARN")
  })

  test("a live secret present in the shell passes without printing it", () => {
    const findings = compareVars([...plain, { type: "secret_text", name: "CEREBRAS_API_KEY" }], { CEREBRAS_API_KEY: "sk-live-value" })
    const pass = findings.find((f) => f.check === "secret CEREBRAS_API_KEY")
    expect(pass?.level).toBe("PASS")
    expect(JSON.stringify(findings)).not.toContain("sk-live-value")
  })

  test("a frozen var whose live value differs is a FAIL", () => {
    const drifted = plain.map((b) => (b.name === "BILLING_UPSTREAM_URL" ? { ...b, text: "https://elsewhere" } : b))
    expect(compareVars(drifted, {}).find((f) => f.check === "var BILLING_UPSTREAM_URL")?.level).toBe("FAIL")
  })

  /*
   * Alchemy's ConfigProvider interceptor records every `Config` the init
   * phase reads as a Redacted output (Platform.ts:572-577), `Config.string`
   * included, so an optional knob lands on the live script as `secret_text`.
   * Reading it back as an undeclared secret would tell the operator to delete
   * a knob src/workerIdentity.ts declares.
   */
  test("an optional knob living as a secret is a knob, not an undeclared secret", () => {
    const live = [...plain, { type: "secret_text", name: "CEREBRAS_MODEL" } as const]
    const findings = compareVars(live, {})
    expect(findings.find((f) => f.check === "knob CEREBRAS_MODEL")?.detail).toContain("DROPS")
    expect(findings.find((f) => f.check === "live secret CEREBRAS_MODEL")).toBeUndefined()
  })

  test("an optional knob present in the shell passes without printing it", () => {
    const live = [...plain, { type: "secret_text", name: "CEREBRAS_MODEL" } as const]
    const findings = compareVars(live, { CEREBRAS_MODEL: "qwen-3-coder-480b" })
    expect(findings.find((f) => f.check === "knob CEREBRAS_MODEL")?.level).toBe("PASS")
    expect(JSON.stringify(findings)).not.toContain("qwen-3-coder-480b")
  })

  test("a Wrangler-era knob still bound as plain_text is reported the same way", () => {
    const live = [...plain, { type: "plain_text", name: "UPSTREAM_TIMEOUT_MS", text: "20000" } as const]
    const findings = compareVars(live, {})
    expect(findings.find((f) => f.check === "knob UPSTREAM_TIMEOUT_MS")?.level).toBe("FAIL")
    expect(findings.find((f) => f.check === "live var UPSTREAM_TIMEOUT_MS")).toBeUndefined()
  })

  test("a knob the live script does not carry is not reported at all", () => {
    const findings = compareVars(plain, {})
    expect(findings.filter((f) => f.check.startsWith("knob "))).toEqual([])
  })

})

/*
 * The script is read-only. It used to carry a `--apply` branch that spawned
 * `alchemy deploy` directly, skipping the site build, the sha stamp and the
 * receipt every canary probe grades the deployment against.
 */
describe("the preflight never deploys", () => {
  const code = stripComments(readFileSync(new URL("./adopt-durable-objects.ts", import.meta.url), "utf8"))

  test("no --apply flag and no process spawn", () => {
    expect(code).not.toContain("--apply")
    expect(code).not.toContain("Bun.spawn")
    expect(code).not.toContain("alchemy.ts")
  })

  test("it reads the flag that downgrades a dropped secret, and nothing else", () => {
    expect(code).toContain('process.argv.includes("--allow-secret-drop")')
  })

  test("the header points at the one deploy path", () => {
    const header = readFileSync(new URL("./adopt-durable-objects.ts", import.meta.url), "utf8").split("*/")[0]!
    expect(header).toContain("bun scripts/deploy.ts")
    expect(header).toContain("It never deploys")
  })
})

test("wrangler.jsonc, the adoption bridge, agrees with src/workerIdentity.ts", () => {
  expect(compareBridge().map((f) => f.level)).toEqual(["PASS", "PASS"])
})
