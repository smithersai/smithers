/**
 * Adoption preflight for the first `alchemy deploy` of `smithers-mvp-web`.
 *
 *   bun scripts/adopt-durable-objects.ts                       # report only; exits 1 on a mismatch
 *   bun scripts/adopt-durable-objects.ts --allow-secret-drop   # same, but a dropped secret is a warning
 *
 * It never deploys. `bun scripts/deploy.ts` is the one deploy path: it builds
 * the site, stamps it with the sha it records, runs this preflight, deploys,
 * and writes the receipt the canary probes grade the deployment against. A
 * deploy from here would skip all four.
 *
 * Why this exists. The live Worker was deployed by Wrangler and carries no
 * Alchemy ownership tags, so the adopting deploy has no `alchemy:dos:` tag
 * to map bindings to classes. It falls back to matching each declared
 * Durable Object binding to the live one BY BINDING NAME and reusing that
 * class (alchemy WorkerProvider.ts:3452-3470). A declared binding it cannot
 * match becomes a fresh, EMPTY class (`new_sqlite_classes`, :3518), and a
 * live locally-owned binding it does not find in the declaration becomes a
 * `deleted_classes` migration (:3311-3330). Either is data loss, and the
 * upload replaces every binding (`keepBindings: undefined`, :3584), so a
 * secret set with `wrangler secret put` but absent from the deploying shell
 * is dropped. This script reads the live script settings and refuses unless
 * src/workerIdentity.ts (what src/Worker.ts deploys), wrangler.jsonc (the
 * bridge), and Cloudflare agree.
 *
 * With CLOUDFLARE_API_TOKEN unset it prints what it would check and exits 0,
 * marked INCONCLUSIVE, so a credential-less shell can still read the plan.
 * It never prints a secret value: only names, kinds, and presence.
 *
 * Read-only, always: only GETs, the same endpoints
 * scripts/canary/rollback-probe.ts uses (shapes read back live 2026-08-18).
 */
import { readWranglerConfig } from "../src/wranglerConfig"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import type { DurableObjectIdentity } from "../src/workerIdentity"

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4"

export type Level = "PASS" | "FAIL" | "WARN" | "INFO" | "SKIP"
export interface Finding {
  readonly level: Level
  readonly check: string
  readonly detail: string
}

/** A binding as `GET .../workers/scripts/{name}/settings` reports it. */
export interface LiveBinding {
  readonly type: string
  readonly name: string
  readonly class_name?: string
  readonly script_name?: string
  readonly text?: string
}

const pair = (binding: DurableObjectIdentity): string => `${binding.binding}=${binding.className}`

/**
 * The one comparison that gates the deploy: the live locally-owned Durable
 * Object bindings and the declared ones must be the same set of
 * (binding name, class name) pairs. Order does not matter to Alchemy.
 */
export const compareDurableObjects = (
  declared: ReadonlyArray<DurableObjectIdentity>,
  live: ReadonlyArray<LiveBinding>,
  scriptName: string
): ReadonlyArray<Finding> => {
  const owned = live.filter(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      (binding.script_name === undefined || binding.script_name === scriptName)
  )
  const liveByName = new Map(owned.map((binding) => [binding.name, binding.class_name ?? ""]))
  const declaredByName = new Map(declared.map((binding) => [binding.binding, binding.className]))
  const findings: Finding[] = []
  for (const binding of declared) {
    const liveClass = liveByName.get(binding.binding)
    if (liveClass === undefined) {
      findings.push({
        level: "FAIL",
        check: `binding ${binding.binding} exists on the live script`,
        detail: `${pair(binding)} is declared but the live script has no binding named ${binding.binding}; Alchemy would CREATE an empty class ${binding.className} (new_sqlite_classes)`
      })
    } else if (liveClass !== binding.className) {
      findings.push({
        level: "FAIL",
        check: `binding ${binding.binding} names the same class live`,
        detail: `declared ${pair(binding)} but live is ${binding.binding}=${liveClass}; Alchemy would RENAME the class (renamed_classes) on the adopting deploy`
      })
    } else {
      findings.push({ level: "PASS", check: `binding ${binding.binding}`, detail: `${pair(binding)} matches live` })
    }
  }
  for (const [name, className] of liveByName) {
    if (!declaredByName.has(name)) {
      findings.push({
        level: "FAIL",
        check: `live binding ${name} is declared`,
        detail: `the live script binds ${name}=${className} but src/workerIdentity.ts does not; Alchemy would DELETE class ${className} and its storage (deleted_classes)`
      })
    }
  }
  return findings
}

/** wrangler.jsonc (the bridge) must say what src/workerIdentity.ts says. */
export const compareBridge = (): ReadonlyArray<Finding> => {
  const config = readWranglerConfig()
  const bridge = config.durable_objects.bindings.map((binding) => `${binding.name}=${binding.class_name}`).sort()
  const declared = WORKER_IDENTITY.durableObjects.map(pair).sort()
  const same = bridge.length === declared.length && bridge.every((entry, index) => entry === declared[index])
  return [
    same
      ? { level: "PASS", check: "wrangler.jsonc agrees with src/workerIdentity.ts", detail: declared.join(", ") }
      : { level: "FAIL", check: "wrangler.jsonc agrees with src/workerIdentity.ts", detail: `wrangler: ${bridge.join(", ")}; identity: ${declared.join(", ")}` },
    config.name === WORKER_IDENTITY.name
      ? { level: "PASS", check: "wrangler.jsonc name", detail: config.name }
      : { level: "FAIL", check: "wrangler.jsonc name", detail: `${config.name} != ${WORKER_IDENTITY.name}` }
  ]
}

/**
 * Vars and secrets.
 *
 * Two channels reach the deployed script, and they are not the two you would
 * guess. `WORKER_IDENTITY.vars` are literal strings in src/Worker.ts's `env`
 * props, so they deploy as `plain_text` (alchemy WorkerAsyncBindings.ts:355-364).
 * Everything the init closure reads through `Config` — every secret AND every
 * entry of `WORKER_IDENTITY.optionalVars` — is recorded by Alchemy's
 * ConfigProvider interceptor as `Output.literal(Redacted.make(value))`
 * (Platform.ts:572-577), stored with the Redacted wrapper kept on the outside
 * (WorkerRuntimeContext.ts:48-57) and lowered to `secret_text`
 * (WorkerAsyncBindings.ts:366-373). So an optional knob that is set at deploy
 * time appears on the live script as a SECRET, not as a var, and this
 * function reads it back from either channel.
 */
export const compareVars = (
  live: ReadonlyArray<LiveBinding>,
  env: Readonly<Record<string, string | undefined>>,
  options?: { readonly allowSecretDrop?: boolean }
): ReadonlyArray<Finding> => {
  /*
   * A live secret the deploying shell does not carry is DROPPED by the
   * upload, and the route it feeds answers its honest 501/503 from that
   * moment until someone notices. That is a production outage, not a note,
   * so it FAILS and the deploy stops. `--allow-secret-drop` is the deliberate
   * escape hatch for retiring one, and it says so in the output.
   *
   * An UNDECLARED live secret stays a WARN: src/workerIdentity.ts is the list
   * of what the Worker reads, so a name outside it feeds nothing, cannot be
   * exported into a declared slot, and is meant to go (the legacy `GATEWAY_*`
   * and `RECO_ADMIN_TOKEN` names). Failing on those would make every deploy
   * need the escape hatch, which is the same as having no gate.
   */
  const dropped: Level = options?.allowSecretDrop === true ? "WARN" : "FAIL"
  const dropSuffix = options?.allowSecretDrop === true ? "" : " (or pass --allow-secret-drop to retire it on purpose)"
  const findings: Finding[] = []
  const livePlain = new Map(live.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text ?? ""]))
  for (const [name, value] of Object.entries(WORKER_IDENTITY.vars)) {
    const liveValue = livePlain.get(name)
    if (liveValue === undefined) findings.push({ level: "WARN", check: `var ${name}`, detail: `declared (${value}) but not on the live script; the deploy adds it` })
    else if (liveValue !== value) findings.push({ level: "FAIL", check: `var ${name}`, detail: `live is ${liveValue}, declared is ${value}; the deploy would change a frozen var` })
    else findings.push({ level: "PASS", check: `var ${name}`, detail: value })
  }
  const declaredNames = new Set([...Object.keys(WORKER_IDENTITY.vars), ...WORKER_IDENTITY.optionalVars])
  for (const [name] of livePlain) {
    if (!declaredNames.has(name)) findings.push({ level: "WARN", check: `live var ${name}`, detail: `not declared by src/workerIdentity.ts; the deploy DROPS it` })
  }
  const liveSecrets = new Set(live.filter((b) => b.type === "secret_text").map((b) => b.name))
  for (const name of WORKER_IDENTITY.secrets) {
    const isLive = liveSecrets.has(name)
    const inShell = env[name] !== undefined && env[name] !== ""
    if (isLive && !inShell) findings.push({ level: dropped, check: `secret ${name}`, detail: `set on the live script but absent from this shell; the deploy DROPS it (export ${name} first${dropSuffix})` })
    else if (isLive && inShell) findings.push({ level: "PASS", check: `secret ${name}`, detail: "live and present in this shell (value not shown)" })
    else if (!isLive && inShell) findings.push({ level: "INFO", check: `secret ${name}`, detail: "not live today; present in this shell, the deploy adds it" })
    else findings.push({ level: "INFO", check: `secret ${name}`, detail: "not live and not in this shell; its route answers its honest 501/503" })
  }
  // An optional knob lives in whichever channel last deployed it: `secret_text`
  // once an Alchemy deploy has read it through `Config`, `plain_text` on the
  // Wrangler-era script. Either way it is DROPPED unless this shell exports it.
  for (const name of WORKER_IDENTITY.optionalVars) {
    const isLive = liveSecrets.has(name) || livePlain.has(name)
    if (!isLive) continue
    if (env[name] === undefined || env[name] === "") {
      findings.push({ level: dropped, check: `knob ${name}`, detail: `set on the live script but absent from this shell; the deploy DROPS it (export ${name} to keep it${dropSuffix})` })
    } else {
      findings.push({ level: "PASS", check: `knob ${name}`, detail: "live and present in this shell (value not shown)" })
    }
  }
  const knobNames = new Set<string>(WORKER_IDENTITY.optionalVars)
  for (const name of liveSecrets) {
    if (knobNames.has(name)) continue
    if (!WORKER_IDENTITY.secrets.includes(name)) findings.push({ level: "WARN", check: `live secret ${name}`, detail: `not declared by src/workerIdentity.ts; the deploy DROPS it (legacy secrets are expected to go, DEPLOY.md "1.0 gateway migration")` })
  }
  return findings
}

const argOf = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const cloudflareGet = async (apiToken: string, path: string): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> => {
  const base = process.env.CLOUDFLARE_API_BASE ?? DEFAULT_API_BASE
  try {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${apiToken}` } })
    const text = await response.text()
    if (!response.ok) return { ok: false, detail: `${path} answered ${response.status}: ${text.slice(0, 200)}` }
    const body = JSON.parse(text) as { success?: boolean; result?: unknown }
    if (body.success !== true) return { ok: false, detail: `${path} answered success=false: ${text.slice(0, 200)}` }
    return { ok: true, value: body.result }
  } catch (error) {
    return { ok: false, detail: `${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const print = (finding: Finding): void => {
  const line = `${finding.level.padEnd(4)} ${finding.check}: ${finding.detail}`
  if (finding.level === "FAIL") console.error(line)
  else console.log(line)
}

const explain = (): void => {
  console.log(`[adopt] CLOUDFLARE_API_TOKEN is unset; INCONCLUSIVE. With a token this script would read, read-only:`)
  console.log(`  GET /accounts/${WORKER_IDENTITY.accountId}/workers/scripts/${WORKER_IDENTITY.name}/settings`)
  console.log(`      and hold its durable_object_namespace bindings to: ${WORKER_IDENTITY.durableObjects.map(pair).join(", ")}`)
  console.log(`      (a live binding missing here = deleted class; a declared binding missing live = empty new class),`)
  console.log(`      its plain_text vars to src/workerIdentity.ts, its secret_text names to WORKER_IDENTITY.secrets`)
  console.log(`      and WORKER_IDENTITY.optionalVars (a Config-read knob deploys as secret_text, not plain_text),`)
  console.log(`      (a live secret or knob absent from this shell is dropped by the deploy), its compatibility date/flags,`)
  console.log(`      and whether alchemy:* ownership tags already exist (then this is not an adoption).`)
  console.log(`  GET /accounts/${WORKER_IDENTITY.accountId}/workers/domains?service=${WORKER_IDENTITY.name}`)
  console.log(`      ${WORKER_IDENTITY.domain.name} must be attached to this script or to nothing.`)
  console.log(`  GET /zones/${WORKER_IDENTITY.domain.zoneId}/workers/routes`)
  console.log(`      ${WORKER_IDENTITY.routes.map((r) => r.pattern).join(", ")} must belong to this script or to nothing; other routes of this script in the zone would be removed.`)
  console.log(`  GET /accounts/${WORKER_IDENTITY.accountId}/workers/scripts/${WORKER_IDENTITY.name}/subdomain`)
  console.log(`      reported against workersDev=${WORKER_IDENTITY.workersDev}.`)
}

const main = async (): Promise<number> => {
  const allowSecretDrop = process.argv.includes("--allow-secret-drop")
  const findings: Finding[] = [...compareBridge()]
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const accountId = argOf("--account") ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? WORKER_IDENTITY.accountId
  const name = WORKER_IDENTITY.name

  if (apiToken === undefined || apiToken === "") {
    findings.forEach(print)
    explain()
    return findings.some((f) => f.level === "FAIL") ? 1 : 0
  }

  const settings = await cloudflareGet(apiToken, `/accounts/${accountId}/workers/scripts/${name}/settings`)
  if (!settings.ok) {
    findings.push({ level: "FAIL", check: "read live script settings", detail: settings.detail })
  } else {
    const result = settings.value as {
      bindings?: ReadonlyArray<LiveBinding>
      compatibility_date?: string
      compatibility_flags?: ReadonlyArray<string>
      tags?: ReadonlyArray<string>
      observability?: unknown
      logpush?: boolean
    }
    const bindings = result.bindings ?? []
    findings.push(...compareDurableObjects(WORKER_IDENTITY.durableObjects, bindings, name))
    findings.push(...compareVars(bindings, process.env, { allowSecretDrop }))
    const flags = [...(result.compatibility_flags ?? [])].sort().join(",")
    const declaredFlags = [...WORKER_IDENTITY.compatibility.flags].sort().join(",")
    findings.push(
      result.compatibility_date === WORKER_IDENTITY.compatibility.date && flags === declaredFlags
        ? { level: "PASS", check: "compatibility", detail: `${result.compatibility_date} [${flags}]` }
        : { level: "FAIL", check: "compatibility", detail: `live ${result.compatibility_date} [${flags}] vs declared ${WORKER_IDENTITY.compatibility.date} [${declaredFlags}]` }
    )
    const alchemyTags = (result.tags ?? []).filter((tag) => tag.startsWith("alchemy:"))
    findings.push(
      alchemyTags.length === 0
        ? { level: "INFO", check: "ownership", detail: "no alchemy:* tags: this is the adopting deploy; run it with --adopt" }
        : { level: "INFO", check: "ownership", detail: `already Alchemy-owned (${alchemyTags.length} alchemy:* tags): not an adoption; binding-name matching does not apply` }
    )
    findings.push({ level: "INFO", check: "observability", detail: `live: ${JSON.stringify(result.observability ?? null)}; Alchemy deploys logs enabled unless src/Worker.ts sets observability` })
    findings.push({ level: "INFO", check: "migration tag", detail: `Cloudflare does not report it here; wrangler.jsonc's last tag is ${readWranglerConfig().migrations.at(-1)?.tag}. Alchemy reads the live tag from the upload precondition error and re-uploads with old_tag set and the SAME class lists as the first attempt (WorkerProvider.ts:3707-3747), so the tag recovery is safe exactly when the binding checks above are all PASS` })
    const asset = bindings.find((b) => b.type === "assets")
    findings.push(asset ? { level: "PASS", check: "assets binding", detail: asset.name } : { level: "WARN", check: "assets binding", detail: "the live script has no assets binding; the deploy adds ASSETS" })
  }

  const domains = await cloudflareGet(apiToken, `/accounts/${accountId}/workers/domains?service=${name}`)
  if (domains.ok) {
    const attached = (domains.value as ReadonlyArray<{ hostname?: string; service?: string; zone_id?: string }>) ?? []
    const canary = attached.find((d) => d.hostname === WORKER_IDENTITY.domain.name)
    findings.push(
      canary
        ? { level: "PASS", check: `domain ${WORKER_IDENTITY.domain.name}`, detail: `attached to ${name} (zone ${canary.zone_id})` }
        : { level: "WARN", check: `domain ${WORKER_IDENTITY.domain.name}`, detail: `not attached to ${name}; the deploy attaches it, and fails if another Worker holds it` }
    )
    for (const other of attached) {
      if (other.hostname !== WORKER_IDENTITY.domain.name) findings.push({ level: "WARN", check: `domain ${other.hostname}`, detail: `attached to ${name} but not declared; Alchemy leaves undeclared domains alone only when \`domain\` is omitted, so check DEPLOY.md before deploying` })
    }
  } else findings.push({ level: "WARN", check: "read domains", detail: domains.detail })

  const routes = await cloudflareGet(apiToken, `/zones/${WORKER_IDENTITY.domain.zoneId}/workers/routes`)
  if (routes.ok) {
    const zoneRoutes = (routes.value as ReadonlyArray<{ id?: string; pattern?: string; script?: string }>) ?? []
    for (const route of WORKER_IDENTITY.routes) {
      const live = zoneRoutes.find((r) => r.pattern === route.pattern)
      if (live === undefined) findings.push({ level: "WARN", check: `route ${route.pattern}`, detail: "not in the zone; the deploy creates it" })
      else if (live.script !== name) findings.push({ level: "FAIL", check: `route ${route.pattern}`, detail: `belongs to ${live.script ?? "<none>"}; Alchemy refuses to attach it (WorkerProvider.ts:1959-1974)` })
      else findings.push({ level: "PASS", check: `route ${route.pattern}`, detail: `attached to ${name} (id ${live.id})` })
    }
    for (const live of zoneRoutes) {
      if (live.script === name && !WORKER_IDENTITY.routes.some((r) => r.pattern === live.pattern)) {
        findings.push({ level: "WARN", check: `route ${live.pattern}`, detail: `attached to ${name} but not declared; the deploy REMOVES it (WorkerProvider.ts:1934-1945)` })
      }
    }
  } else findings.push({ level: "WARN", check: "read zone routes", detail: routes.detail })

  const subdomain = await cloudflareGet(apiToken, `/accounts/${accountId}/workers/scripts/${name}/subdomain`)
  if (subdomain.ok) {
    const state = subdomain.value as { enabled?: boolean; previews_enabled?: boolean }
    findings.push(
      state.enabled === WORKER_IDENTITY.workersDev
        ? { level: "PASS", check: "workers.dev", detail: `enabled=${state.enabled} previews=${state.previews_enabled}` }
        : { level: "WARN", check: "workers.dev", detail: `live enabled=${state.enabled} previews=${state.previews_enabled}; declared workersDev=${WORKER_IDENTITY.workersDev}, the deploy changes it` }
    )
  } else findings.push({ level: "INFO", check: "workers.dev", detail: subdomain.detail })

  findings.forEach(print)
  const failed = findings.filter((f) => f.level === "FAIL").length
  const warned = findings.filter((f) => f.level === "WARN").length
  console.log(`[adopt] ${failed === 0 ? "GREEN" : "RED"}: ${failed} fail, ${warned} warn`)
  if (failed > 0) {
    console.error("[adopt] refusing: fix every FAIL before an adopting deploy. A binding mismatch is Durable Object data loss; a dropped secret is an outage of the route it feeds.")
    return 1
  }
  if (allowSecretDrop) console.log("[adopt] --allow-secret-drop: a live secret missing from this shell was graded a warning, not a failure. It WILL be dropped by the deploy.")
  console.log("[adopt] report only; this script never deploys. The deploy is `bun scripts/deploy.ts`, which builds the site, stamps it, runs this preflight, and writes the receipt.")
  return 0
}

if (import.meta.main) process.exit(await main())
