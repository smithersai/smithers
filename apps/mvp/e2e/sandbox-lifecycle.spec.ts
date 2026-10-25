import { messageIn } from "./messages"
import type { Page } from "@playwright/test"
import { KEEP_EVERY_SECONDS } from "../src/features/sandbox/contract"
import { expect, step, test } from "./fixtures"
import { uidOf, userOf } from "../worker/branch/Users"
import { me, meets, requires } from "./target"

// A branch's machine over its whole life (docs/features/sandbox-tools.md#sleep-and-wake, decision 0005 §2), end to end
// against the real app, Worker, Durable Objects, Postgres and a real container, locally (`alchemy dev` with Docker) and
// in a deployment (Cloudflare Containers): the agent runs a tool on it, the person's terminal sees the agent's file and
// commits in it, the machine stays awake while a command runs, sleeps once nothing has happened for the idle time, and
// wakes with the working copy, the commit included. Locally the agent's model is scripted in the browser's engine
// worker (`?agent=sandbox-once`, src/test/scriptedAgent.ts); a deployment asks the real model. The idle time is the
// target's `SANDBOX_IDLE_SECONDS` (run the dev server with 60 to finish in minutes; production's is 900). The fixture
// is the public `octocat/Spoon-Knife`'s `test-branch`, cloned in a deployment; nothing is written to GitHub.

// Opening a terminal and calling a tool are a Member's.
requires("member")

const BRANCH = "/octocat/Spoon-Knife/tree/test-branch"

/** How long the machine may be idle before it sleeps: the dev server's setting, which this run must share. */
const IDLE_SECONDS = Number(process.env.SANDBOX_IDLE_SECONDS ?? 900)

/** A machine's first wake: locally `alchemy dev` may build the image first (about two minutes); then a cold start. */
const MACHINE = 360_000

/** The longest a sleep may take once the machine is idle: the idle time and two of `sandbox/Keep`'s asks. */
const SLEEPS_WITHIN = (IDLE_SECONDS + 2 * KEEP_EVERY_SECONDS + 60) * 1000

const terminalRows = (page: Page) => page.frameLocator('iframe[title="Terminal"]').locator("body")
const openButton = (page: Page) => page.getByRole("button", { name: "Open terminal" })
const conversationOf = (page: Page) => page.getByRole("region", { name: "Conversation", exact: true })

// The terminal echoes what is typed, so each check looks for output the typed line can't contain: arithmetic the shell
// expands, or a file's content.

/** Types `line` into the terminal frame and presses Enter. */
const keys = async (page: Page, line: string) => {
  await page.locator('iframe[title="Terminal"]').click()
  await page.keyboard.type(line)
  await page.keyboard.press("Enter")
}

/** `keys` as a chapter of its own. */
const type = (page: Page, line: string) => step(`Type "${line}"`, () => keys(page, line))

/** Presses Open terminal until the shell shows `/workspace`. */
const openTerminal = (page: Page, label: string) =>
  step(label, async () => {
    await expect(async () => {
      if ((await openButton(page).isVisible()) && (await openButton(page).isEnabled())) await openButton(page).click()
      await expect(terminalRows(page)).toContainText("/workspace", { timeout: 15_000 })
    }).toPass({ timeout: MACHINE })
  })

test("sandbox lifecycle: the agent and the terminal share the branch's machine, which stays awake while a command runs, sleeps when idle and wakes with the working copy", {
  annotation: {
    type: "summary",
    description:
      "The agent and the terminal use one machine per branch. It never sleeps while a command runs, sleeps once idle, and wakes with every file and commit.",
  },
}, async ({ page }) => {
  test.setTimeout(2 * MACHINE + (IDLE_SECONDS + 90) * 1000 + SLEEPS_WITHIN + 5 * 60_000)
  const word = `life-${Date.now()}`

  await page.goto(`${BRANCH}?terminal=me`)
  await openTerminal(page, "Open the terminal on the branch's machine")
  await step("The shell runs as the person's own numeric user", async () => {
    await keys(page, `echo uid-$(id -u)`)
    await expect(terminalRows(page)).toContainText(`uid-${uidOf(userOf(me().personId))}`, { timeout: 30_000 })
  })
  // A commit only this machine has, and a file typed after it.
  await type(
    page,
    `echo kept-${word} > t-${word}.txt && git add -A && git -c user.name=e2e -c user.email=e2e@example.com commit -qm w-${word} && echo typed-${word} > after.txt && touch ~/machine-${word} && echo committed-$((1+1))-${word}`,
  )
  await expect(terminalRows(page)).toContainText(`committed-2-${word}`, { timeout: 30_000 })

  await step("A command running past the idle time keeps the machine awake", async () => {
    await keys(page, `sleep ${IDLE_SECONDS + 90}; echo done-$((2+2))-${word}`)
    // The command prints only once it has run past the idle time: a machine that slept under it would have ended its
    // shell first. The same shell, still attached, shows it.
    await expect(terminalRows(page)).toContainText(`done-4-${word}`, { timeout: (IDLE_SECONDS + 90) * 1000 + 120_000 })
    await expect(openButton(page)).toHaveCount(0)
    await expect(terminalRows(page)).toContainText(`committed-2-${word}`)
  })

  await step("Idle, the machine sleeps and its terminal ends", async () => {
    await expect(openButton(page)).toBeVisible({ timeout: SLEEPS_WITHIN })
  })

  await openTerminal(page, "Open the terminal again: the machine wakes")
  await type(
    page,
    `cat t-${word}.txt after.txt; git log -1 --format=%s; test -e ~/machine-${word} || echo new-machine-$((4+4)); test -e /run/smithers/env || echo no-secrets-$((3+3))`,
  )
  await step("The working copy came back, the commit included", async () => {
    const rows = terminalRows(page)
    await expect(rows).toContainText(`kept-${word}`, { timeout: 30_000 })
    await expect(rows).toContainText(`typed-${word}`)
    await expect(rows).toContainText(`w-${word}`)
    await expect(rows).toContainText("no-secrets-6")
    // A new machine, not the old one's new shell: the marker in the person's home, outside the checkout, is gone.
    await expect(rows).toContainText("new-machine-8")
    // A new machine's new shell: the old one's output is gone.
    await expect(rows).not.toContainText(`done-4-${word}`)
  })

  // Locally the scripted agent runs `echo ran >> runs-<word>.log`; a deployment's real agent writes the same file.
  const scripted = meets("scriptedAgent")
  await step("Ask the agent to run a command on the branch's machine", async () => {
    await page.goto(scripted ? `${BRANCH}?agent=sandbox-once` : BRANCH)
    await expect(page.getByRole("navigation", { name: "Branch" })).toContainText("test-branch", { timeout: 30_000 })
    const composer = page.getByRole("textbox", { name: "Message Smithers" })
    if (!(await composer.isVisible())) await page.getByRole("button", { name: /Chat/ }).click()
    if (scripted) {
      await composer.fill(`sandbox-count ${word}`)
      await composer.press("Enter")
      await expect(messageIn(conversationOf(page), `Counted 1; the log has 1 line(s) for ${word}.`)).toBeVisible({
        timeout: MACHINE,
      })
      return
    }
    // The real agent: its `run` call reaches ChatApi; the terminal below reads the file it wrote.
    const ran = page.waitForRequest((request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/sandbox/calls" &&
      (request.postDataJSON() as { call: { tool: string } }).call.tool === "run", { timeout: MACHINE })
    await composer.fill(`Use the sandbox tools on this branch: run the command: echo ran >> runs-${word}.log`)
    await composer.press("Enter")
    await ran
  })

  await page.goto(`${BRANCH}?terminal=me`)
  await openTerminal(page, "Back to the woken machine's shell")
  await step("The agent's file is in the terminal's checkout: one machine per branch", async () => {
    await expect(async () => {
      await keys(page, `echo log-$(cat runs-${word}.log)`)
      await expect(terminalRows(page)).toContainText("log-ran", { timeout: 10_000 })
    }).toPass({ timeout: MACHINE })
  })
  // The fixture branch's machine keeps its checkout across sleeps: leave it as the forge has it, so the commit and files
  // made here don't change what other specs read there (branch-workspace's `git log`).
  await step("Leave the branch's checkout as the forge has it", async () => {
    await keys(page, "git reset -q --hard origin/test-branch && git clean -qfd && echo clean-$((3+3))")
    await expect(terminalRows(page)).toContainText("clean-6", { timeout: 30_000 })
  })
})

// Most repositories install packages and build with a toolchain (ruling ARCH-15, decision 0005 §2): the branch's own
// box reaches the package registries through its egress, never with a secret, and its image carries Go and Python.
// Everything happens outside the checkout, in a scratch directory under the person's home.
test("packages and toolchains: the branch's machine installs a package from the registry and runs Go and Python", {
  annotation: {
    type: "summary",
    description: "A branch's machine installs packages from npm and PyPI and has Go and Python, so most repositories build there.",
  },
}, async ({ page }) => {
  test.setTimeout(MACHINE + 6 * 60_000)
  const word = `pkg-${Date.now()}`
  await page.goto(`${BRANCH}?terminal=me`)
  await openTerminal(page, "Open the terminal on the branch's machine")
  const rows = terminalRows(page)

  await type(page, `mkdir -p ~/${word} && cd ~/${word} && npm init -y >/dev/null && npm install --no-audit --no-fund left-pad@1.3.0 >/dev/null && node -e "console.log(require('left-pad')('npm', 7, '+'))"`)
  await step("npm installs a package from its registry", async () => {
    // The typed line holds 'npm', 7 and '+', never the padded word.
    await expect(rows).toContainText("++++npm", { timeout: 4 * 60_000 })
  })

  await type(page, `python3 -m venv ~/${word}/venv && ~/${word}/venv/bin/pip install -q --disable-pip-version-check six==1.16.0 && ~/${word}/venv/bin/python -c "import six; print('six-' + six.__version__.replace('.', '_'))"`)
  await step("pip installs a package from PyPI", async () => {
    await expect(rows).toContainText("six-1_16_0", { timeout: 4 * 60_000 })
  })

  await type(page, "go version")
  await step("Go runs", async () => {
    await expect(rows).toContainText(/go version go1\.\d+/, { timeout: 30_000 })
  })

  await step("Leave the machine as it was", async () => {
    await keys(page, `cd /workspace && rm -rf ~/${word} && echo gone-$((5+5))`)
    await expect(rows).toContainText("gone-10", { timeout: 30_000 })
  })
})
