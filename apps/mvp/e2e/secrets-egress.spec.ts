import type { Page, TestInfo } from "@playwright/test"
import { randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { expect, step, test } from "./fixtures"
import { LogTail, recordOf } from "./logs"
import { httpsReceiver } from "./secret-receiver"
import { requires, target } from "./target"

// Production-capable public-boundary journey. Production's prerequisites are a BLOCKED result, never a green
// local-only skip. The existing secrets.spec.ts retains Docker's independent filesystem/process inspection.
test.use({ trace: "off", video: "off", screenshot: "off" })

const phase = (title: string, run: () => Promise<void>) => step(title, async () => {
  console.info(`secret proof: ${title}`)
  await run()
})
const go = (page: Page, path: string) => page.goto(path, { waitUntil: "domcontentloaded", timeout: 30_000 })
const rows = (page: Page) => page.frameLocator('iframe[title="Terminal"]').locator("body")
const terminal = async (page: Page, command: string) => {
  await page.locator('iframe[title="Terminal"]').click()
  await page.keyboard.type(command)
  await page.keyboard.press("Enter")
}
const receiptFile = async (info: TestInfo, name: string, value: unknown) => {
  await mkdir(info.outputDir, { recursive: true })
  const path = info.outputPath(`${name}.json`)
  await writeFile(path, JSON.stringify(value, null, 2))
  await info.attach(name, { path, contentType: "application/json" })
}
const wake = async (page: Page, branch: string) => {
  await go(page, `${branch}?terminal=me`)
  const open = page.getByRole("button", { name: "Open terminal" })
  await expect(async () => {
    if (await open.isVisible() && await open.isEnabled()) await open.click()
    await expect(rows(page)).toContainText("/workspace", { timeout: 15_000 })
  }).toPass({ timeout: 240_000 })
  // This scratch branch belongs to the test. Reopening its shell invokes wake and refreshes the names file;
  // reconnecting a live terminal alone does neither. No existing shell receives newly added environment variables.
  await terminal(page, "exit")
  await expect(open).toBeEnabled({ timeout: 30_000 })
  await open.click()
  await expect(rows(page)).toContainText("/workspace", { timeout: 240_000 })
}

test("secret egress: the owned receiver proves first use, rotation and revocation without receiving a placeholder", async ({ page, browserLog }, info) => {
  // Keep this ahead of member so a deployment's unconfigured proof has its precise blocking reason.
  requires("secretEgressDeployment")
  if (target === "local") requires("sandboxSecrets")
  requires("member", "localLogs")
  test.setTimeout(12 * 60_000)
  page.setDefaultTimeout(30_000)
  const repo = target === "local" ? "octocat/Spoon-Knife" : process.env.E2E_SECRETS_REPOSITORY!
  const ref = target === "local" ? "test-branch" : process.env.E2E_SECRETS_BRANCH!
  const branch = `/${repo}/tree/${encodeURIComponent(ref)}`
  const name = `E2E_${randomBytes(8).toString("hex").toUpperCase()}`
  const secrets = page.getByRole("main", { name: "Secrets" })
  const row = secrets.getByRole("list", { name: "Secrets" }).getByRole("listitem").filter({ hasText: name })
  const receiver = await httpsReceiver()
  const host = new URL(receiver.url).hostname
  const values = [0, 1].map(() => `e2e-secret-${randomBytes(32).toString("hex")}`)
  const leaked = (text: string) => values.some((value) => text.includes(value))
  const observations = { console: 0, telemetry: 0, transcript: 0, logs: 0 }
  const signals = new Set<string>()
  const exported = { logs: false, metrics: false, put: false, delete: false }
  // These navigations replace the document. Observe the asynchronous exporter before discarding its runtime.
  const beginExport = (op: "put" | "delete") => { exported.logs = false; exported.metrics = false; exported[op] = false }
  const waitForExport = (op: "put" | "delete") => expect.poll(() => ({
    logs: exported.logs, metrics: exported.metrics, span: exported[op],
  }), { timeout: 90_000, message: `the ${op} write exported its log, metric and span` })
    .toEqual({ logs: true, metrics: true, span: true })
  const logs = await LogTail.start().catch(async (error: unknown) => { await receiver.close(); throw error })
  page.context().on("request", (request) => {
    const signal = new URL(request.url()).pathname.match(/^\/api\/telemetry\/v1\/(logs|metrics|traces)$/)?.[1]
    if (signal === undefined) return
    signals.add(signal)
    const body = request.postData() ?? ""
    if (leaked(body)) observations.telemetry++
    if (signal === "logs" && body.includes(name) && body.includes("landed")) exported.logs = true
    if (signal === "metrics" && body.includes("smithers_web_secret_writes")) exported.metrics = true
    if (signal === "traces") {
      if (body.includes("secrets.put")) exported.put = true
      if (body.includes("secrets.delete")) exported.delete = true
    }
  })
  let added = false
  let placeholder = ""
  try {
    await phase("Add a secret for the owned receiver", async () => {
      await go(page, `/${repo}/settings/secrets`)
      const form = secrets.getByRole("form", { name: "Add secret" })
      await form.getByLabel("Name").fill(name)
      await form.getByLabel("Hosts").fill(host)
      await form.getByLabel("Value").fill(values[0]!)
      await form.getByRole("button", { name: "Add secret" }).click()
      added = true
      await expect(row).toContainText(host, { timeout: 120_000 })
      await expect(form.getByLabel("Value")).toHaveValue("")
      observations.transcript += Number(leaked(await page.content()))
      await waitForExport("put")
    })
    for (const version of [1, 2]) {
      if (version === 2) await phase("Rotate the same secret", async () => {
        await go(page, `/${repo}/settings/secrets`)
        beginExport("put")
        await row.getByRole("button", { name: "Rotate" }).click()
        const form = secrets.getByRole("form", { name: `Rotate ${name}` })
        await form.getByLabel("Value").fill(values[1]!)
        await form.getByRole("button", { name: "Save" }).click()
        await expect(form).toBeHidden({ timeout: 120_000 })
        observations.transcript += Number(leaked(await page.content()))
        await waitForExport("put")
      })
      const receipt = receiver.expect(values[version - 1]!)
      await phase(`Use version ${version} through the sandbox egress`, async () => {
        await wake(page, branch)
        await terminal(page, `node -e 'const v=process.env.${name};console.log("placeholder-ok",/^smthrs-secret-[a-f0-9]{64}$/.test(v??""));if(/^smthrs-secret-[a-f0-9]{64}$/.test(v??""))console.log("opaque",v);fetch(${JSON.stringify(receiver.url)},{headers:{authorization:"Bearer "+v}}).then(async r=>console.log("receipt",r.status,await r.text())).catch(()=>console.log("receiver-failed"))'`)
        await expect(rows(page)).toContainText("placeholder-ok true", { timeout: 30_000 })
        // Poll a boolean: a failing assertion cannot print a terminal containing a leaked value.
        // xterm's accessible rows insert line breaks at the viewport width, including within the digest.
        await expect.poll(async () => (await rows(page).innerText()).replace(/\s/g, "").includes(JSON.stringify(receipt)), { timeout: 60_000 }).toBe(true)
        expect(receiver.receipts.at(-1)).toEqual(receipt)
        placeholder = /opaque(smthrs-secret-[a-f0-9]{64})/.exec((await rows(page).innerText()).replace(/\s/g, ""))?.[1] ?? ""
        expect(placeholder.length).toBe(78)
        observations.transcript += Number(leaked(await rows(page).innerText()))
      })
    }
    await phase("Check the public sandbox surfaces without sending either value into the box", async () => {
      // Only a token's public marker pattern goes in; no value or fragment of its random suffix does. File content
      // never comes out. Inspect readable process environments/arguments and user-writable file roots; Docker's
      // companion test covers the whole filesystem and root-owned processes independently.
      const scan = `const fs=require("fs"),path=require("path");const marker=new RegExp(["e2e","secret"].join("-")+"-[a-f0-9]{64}");const out={files:0,environments:0,arguments:0,hits:0,unreadable:0};function read(p,k){try{const s=fs.statSync(p);if(!s.isFile()&& !p.startsWith("/proc/"))return;const fd=fs.openSync(p,"r"),b=Buffer.alloc(65536);let n,t="";try{while((n=fs.readSync(fd,b,0,b.length,null))>0){const q=t+b.subarray(0,n).toString();if(marker.test(q))out.hits++;t=q.slice(-100)}}finally{fs.closeSync(fd)}out[k]++}catch(e){if(!["ENOENT","ESRCH"].includes(e.code))out.unreadable++}}function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else if(e.isFile())read(f,"files")}}for(const p of ["/workspace","/run/smithers",process.env.HOME]){try{walk(p)}catch(e){out.unreadable++}}for(const p of fs.readdirSync("/proc").filter(p=>/^\\d+$/.test(p))){for(const [f,k] of [["environ","environments"],["cmdline","arguments"]]){try{fs.accessSync("/proc/"+p+"/"+f,fs.constants.R_OK)}catch{continue}read("/proc/"+p+"/"+f,k)}}console.log("secret-scan",JSON.stringify(out))`
      await terminal(page, `node -e '${scan.replaceAll("'", "'\\''")}'`)
      let scanResult: { files: number; environments: number; arguments: number; hits: number; unreadable: number } | undefined
      await expect.poll(async () => {
        const text = (await rows(page).innerText()).replace(/\s/g, "")
        const json = /secret-scan(\{"files":\d+[^{}]*\})/.exec(text)?.[1]
        if (json === undefined) return false
        scanResult = JSON.parse(json)
        return true
      }, { timeout: 120_000 }).toBe(true)
      expect(scanResult!.files).toBeGreaterThan(0)
      expect(scanResult!.environments).toBeGreaterThan(0)
      expect(scanResult!.arguments).toBeGreaterThan(0)
      expect(scanResult!.hits).toBe(0)
      expect(scanResult!.unreadable).toBe(0)
      await receiptFile(info, "sandbox-scan-counts", scanResult)
    })
    await phase("Delete the secret and refuse its stale placeholder", async () => {
      await go(page, `/${repo}/settings/secrets`)
      beginExport("delete")
      await row.getByRole("button", { name: "Delete" }).click()
      await secrets.getByRole("button", { name: "Delete secret" }).click()
      await expect(row).toHaveCount(0, { timeout: 120_000 })
      added = false
      await waitForExport("delete")
      await wake(page, branch)
      await terminal(page, `node -e 'fetch(${JSON.stringify(receiver.url)},{headers:{authorization:"Bearer ${placeholder}"}}).then(async r=>console.log("deleted-status",r.status)).catch(()=>console.log("receiver-failed"))'`)
      await expect(rows(page)).toContainText("deleted-status 403", { timeout: 60_000 })
      expect(receiver.receipts.map(({ version }) => version)).toEqual([1, 2])
      expect(receiver.healthy()).toBe(true)
      observations.transcript += Number(leaked(await rows(page).innerText()))
    })
    await phase("Check logs, exported telemetry and the transcript", async () => {
      await expect.poll(() => [...signals].sort(), { timeout: 90_000 }).toEqual(["logs", "metrics", "traces"])
      await expect.poll(() => exported, { timeout: 90_000 }).toEqual({ logs: true, metrics: true, put: true, delete: true })
      await expect.poll(async () => (await logs.lines()).some(({ text }) => {
        const record = recordOf(text.slice(Math.max(0, text.indexOf("{"))))
        return record?.message === "secrets.egress" && record.annotations?.host === host
      }), { timeout: 30_000 }).toBe(true)
      const lines = await logs.lines()
      const decisions = lines.map(({ text }) => recordOf(text.slice(Math.max(0, text.indexOf("{")))))
        .filter((record) => record?.message === "secrets.egress" && record.annotations?.host === host)
      expect(decisions.filter((record) => record?.annotations?.outcome === "forwarded").length).toBe(2)
      expect(decisions.some((record) => record?.annotations?.status === 403)).toBe(true)
      observations.logs = lines.filter(({ text }) => leaked(text)).length
      observations.transcript += Number(leaked(await page.content()))
      observations.console = browserLog.filter(leaked).length
      expect(observations).toEqual({ console: 0, telemetry: 0, transcript: 0, logs: 0 })
      await receiptFile(info, "secret-egress-receipt", { receiver: receiver.receipts,
        signals: [...signals].sort(), exported, logLines: lines.length, leaks: observations })
    })
  } finally {
    try {
      if (added) {
        // UI cleanup preserves the person's authority. It cannot turn a failed proof green.
        await go(page, `/${repo}/settings/secrets`)
        if (await row.count()) {
          await row.getByRole("button", { name: "Delete" }).click()
          await secrets.getByRole("button", { name: "Delete secret" }).click()
          await expect(row).toHaveCount(0, { timeout: 120_000 })
        }
      }
    } finally {
      await logs.dispose().finally(() => receiver.close())
    }
  }
})
