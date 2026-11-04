import type { Page } from "@playwright/test"
import { execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { expect, step, test } from "./fixtures"
import { LogTail, recordOf } from "./logs"
import { requires } from "./target"

// Repository secrets, end to end (docs/features/secrets.md, decision 0005 §4, ARCH-16): an Admin adds a secret on the
// Secrets page, rotates it, and a command on the branch's machine, a real container under `alchemy dev`, uses it
// against its own host without ever holding it. The box holds a placeholder; the egress outside it puts the value in
// the request only for the secret's host, refuses another host, and scrubs the value from the answer. Then the
// container's files and process environments and everything ChatApi logged are searched for both values, from outside
// the box, and deleting the secret makes the placeholder useless. The allowed host is the public echo service
// httpbingo.org, which answers with the bearer token it received; httpbin.org, which would echo it too, is the other.
//
// The egress is off unless the dev server runs with SANDBOX_SECRETS=true, and an Admin writes only the secrets of the
// repository sign-in reads roles on, so this file runs with GITHUB_REPOSITORY=octocat/Spoon-Knife (`sandboxSecrets`).

requires("member", "sandboxSecrets", "localLogs")
// A trace keeps what was typed and sent, values included; the video masks the password fields.
test.use({ trace: "off" })

const REPO = "/octocat/Spoon-Knife"
const NAME = `DEMO_${randomBytes(8).toString("hex").toUpperCase()}`
const ALLOWED = "httpbingo.org"
const OTHER = "httpbin.org"

/** A machine's first wake builds nothing but may take a while on a cold machine. */
const MACHINE = 240_000

const terminalRows = (page: Page) => page.frameLocator('iframe[title="Terminal"]').locator("body")

/** Types `line` into the terminal frame and presses Enter; `caption` names the step in product words. */
const type = (page: Page, line: string, caption: string) =>
  step(caption, async () => {
    await page.locator('iframe[title="Terminal"]').click()
    await page.keyboard.type(line)
    await page.keyboard.press("Enter")
  })

/**
 * How many of `needles` occur in what `command` writes to stdout, read here, outside the box, as it streams. A scan that
 * fails or reads nothing fails, so it never passes as clean.
 */
const found = (command: string, args: ReadonlyArray<string>, needles: ReadonlyArray<string>) =>
  new Promise<number>((resolve, reject) => {
    const targets = needles.map((needle) => Buffer.from(needle))
    const keep = Math.max(...targets.map((target) => target.length)) - 1
    const hits = new Set<string>()
    let tail = Buffer.alloc(0)
    let bytes = 0
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] })
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      const joined = Buffer.concat([tail, chunk])
      targets.forEach((target, at) => void (joined.includes(target) && hits.add(needles[at]!)))
      tail = joined.subarray(Math.max(0, joined.length - keep))
    })
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 && bytes > 0 ? resolve(hits.size) : reject(new Error(`${command} ${args[0]} read ${bytes} bytes, exit ${code}`)))
  })

/** The branch machines `alchemy dev` runs in local Docker: every container but the compose services. */
const boxes = (placeholder: string) =>
  execFileSync("docker", ["ps", "--format", "{{.ID}} {{.Image}}"]).toString().trim().split("\n")
    .map((line) => line.split(" ") as [string, string])
    .filter(([, image]) => !/postgres|electric|pgbouncer|buildkit/.test(image))
    .map(([id]) => id)
    .filter((id) => {
      try {
        execFileSync("docker", ["exec", "--user", "0:0", id, "grep", "-Fxq", `${NAME}=${placeholder}`, "/run/smithers/env"], { stdio: "ignore" })
        return true
      } catch { return false }
    })

const secretsPage = (page: Page) => page.getByRole("main", { name: "Secrets" })
const rowOf = (page: Page) => secretsPage(page).getByRole("list", { name: "Secrets" }).getByRole("listitem").filter({ hasText: NAME })

test("secrets: an Admin adds and rotates a secret, and a command on the branch's machine uses it against its own host without holding it", {
  annotation: {
    type: "summary",
    description: "The box holds a placeholder; only the secret's own host gets the value, another host is refused, the echo comes back scrubbed, and the value is nowhere in the box or the logs.",
  },
}, async ({ page }) => {
  test.setTimeout(10 * 60_000)
  const first = `e2e-first-${randomBytes(16).toString("hex")}`
  const value = `e2e-rotated-${randomBytes(16).toString("hex")}`
  const logs = await LogTail.start()

  await step("Open the repository's Secrets page", async () => {
    await page.goto(REPO)
    await page.getByRole("link", { name: "Secrets" }).click()
    await expect(secretsPage(page)).toBeVisible({ timeout: 30_000 })
  })

  await step(`Add ${NAME}, bound to ${ALLOWED}`, async () => {
    const form = secretsPage(page).getByRole("form", { name: "Add secret" })
    await form.getByLabel("Name").fill(NAME)
    await form.getByLabel("Value").fill(first)
    await form.getByLabel("Hosts").fill(ALLOWED)
    await form.getByRole("button", { name: "Add secret" }).click()
    await expect(rowOf(page)).toContainText(ALLOWED, { timeout: 30_000 })
    // Never shown again: the field is empty and the page holds no part of it.
    await expect(form.getByLabel("Value")).toHaveValue("")
    expect((await secretsPage(page).innerText()).includes(first), "the page contains no first value").toBe(false)
  })

  await step(`Rotate ${NAME} to a new value`, async () => {
    await rowOf(page).getByRole("button", { name: "Rotate" }).click()
    const form = secretsPage(page).getByRole("form", { name: `Rotate ${NAME}` })
    await expect(form.getByLabel("Hosts")).toHaveValue(ALLOWED)
    await form.getByLabel("Value").fill(value)
    await form.getByRole("button", { name: "Save" }).click()
    await expect(form).toBeHidden({ timeout: 30_000 })
    expect((await page.content()).includes(value), "the page contains no rotated value").toBe(false)
  })

  await step("Open the terminal on the branch's machine", async () => {
    await page.goto(`${REPO}/tree/test-branch?terminal=me`)
    const open = page.getByRole("button", { name: "Open terminal" })
    await expect(async () => {
      if ((await open.isVisible()) && (await open.isEnabled())) await open.click()
      await expect(terminalRows(page)).toContainText("/workspace", { timeout: 15_000 })
    }).toPass({ timeout: MACHINE })
    // The preceding journey may have left a shell open before this name existed. Opening a new terminal wakes
    // the machine and refreshes its names; reconnecting the old shell does not change its environment.
    await type(page, "exit", "Close the previous shell")
    await expect(open).toBeEnabled({ timeout: 30_000 })
    await open.click()
    await expect(terminalRows(page)).toContainText("/workspace", { timeout: MACHINE })
  })

  // The box holds a placeholder, never the value.
  await type(page, `echo "$${NAME}"`, "Print the secret's variable in the box")
  await expect(terminalRows(page)).toContainText(/smthrs-secret-[0-9a-f]{64}/, { timeout: 30_000 })
  const placeholder = /smthrs-secret-[0-9a-f]{64}/.exec(await terminalRows(page).innerText())![0]

  // The secret's own host gets the value and echoes it; the box reads its own placeholder back. That the host got the
  // rotated value, not the placeholder: the egress's decision below counts one substitution, an earlier value would
  // reach the box unscrubbed (only the current value is in the policy), and the terminal shows neither.
  // The image has Node, not curl: `get <url>` sends the secret as a bearer token and prints the host, status and body.
  await type(page, `get() { node -e 'fetch(process.argv[1], { headers: { authorization: "Bearer " + process.env.${NAME} } }).then(async (r) => console.log(new URL(process.argv[1]).host, r.status, await r.text()), (e) => console.log("failed", e.cause?.code ?? e.message))' "$1"; }`, "Define get: a request with the secret as its bearer token")
  await type(page, `get https://${ALLOWED}/bearer`, "Ask the secret's own host, which echoes the token")
  await expect(terminalRows(page)).toContainText(`${ALLOWED} 200`, { timeout: 60_000 })
  await expect(terminalRows(page)).toContainText(/"authenticated":\s*true/)
  await expect(terminalRows(page)).toContainText(new RegExp(`"token":\\s*"${placeholder}"`))

  // Another host never gets it: refused before anything is sent.
  await type(page, `get https://${OTHER}/bearer`, "Ask another host with the same token")
  await expect(terminalRows(page)).toContainText(`${OTHER} 403`, { timeout: 60_000 })

  await step("Search the box and the logs for the values, from outside the box", async () => {
    const machines = boxes(placeholder)
    expect(machines.length, "exactly this branch's machine holds its unique placeholder").toBe(1)
    for (const id of machines) {
      expect(await found("docker", ["export", id], [first, value]), `container ${id}'s files`).toBe(0)
      expect(await found("docker", ["exec", "--user", "0:0", id, "sh", "-c", "cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null; true"], [first, value]), `container ${id}'s processes`).toBe(0)
    }
    const lines = await logs.lines()
    expect(lines.filter((line) => line.text.includes(first) || line.text.includes(value)).length, "log lines with a value").toBe(0)
    // The egress decided both requests, by name and host: forwarded to the secret's host, refused for the other.
    const decisions = lines
      .map((line) => recordOf(line.text.slice(Math.max(0, line.text.indexOf("{")))))
      .filter((record) => record?.message === "secrets.egress")
      .map((record) => record!.annotations ?? {})
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ host: ALLOWED, outcome: "forwarded", secrets: 1 }),
      expect.objectContaining({ host: OTHER, status: 403 }),
    ]))
    const shown = await terminalRows(page).innerText()
    expect([shown.includes(first), shown.includes(value)], "the terminal shows neither value").toEqual([false, false])
  })

  await step(`Delete ${NAME}`, async () => {
    await page.goto(`${REPO}/settings/secrets`)
    await rowOf(page).getByRole("button", { name: "Delete" }).click()
    await secretsPage(page).getByRole("button", { name: "Delete secret" }).click()
    // The flow `secret/Delete` lands it; on a loaded machine that has taken over half a minute.
    await expect(rowOf(page)).toHaveCount(0, { timeout: 120_000 })
  })

  // Deleted, the placeholder the box still holds is worth nothing.
  await page.goto(`${REPO}/tree/test-branch?terminal=me`)
  await expect(terminalRows(page)).toContainText("/workspace", { timeout: MACHINE })
  await type(page, "clear", "Clear the terminal")
  await type(page, `get https://${ALLOWED}/bearer`, "Ask the secret's host again after the delete")
  await expect(terminalRows(page)).toContainText(`${ALLOWED} 403`, { timeout: 60_000 })
})
