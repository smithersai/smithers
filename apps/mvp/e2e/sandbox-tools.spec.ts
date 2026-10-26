import { messageIn, questionIn } from "./messages"
import type { BrowserContext, Page } from "@playwright/test"
import { expect, type Tab, test } from "./devices"
import { meets, requires, scriptedAgent } from "./target"

// The sandbox tools, end to end (docs/features/sandbox-tools.md, decision 0005 §5): the browser's agent calls typed
// tools that run on the branch's own machine, a real container under `alchemy dev` (local workerd and Docker), as the
// person who asked; each call is a durable remote flow whose result is recorded once. The fixture is the public
// `octocat/Spoon-Knife`'s `test-branch`; nothing is written to GitHub. The first test asks the real model; the second
// scripts the agent's model in the asking browser's engine worker (`?agent=sandbox-once`, src/test/scriptedAgent.ts),
// so the tab closes at the same point every time. Everything else is real. Both track the branch and ask, a Member's
// (worker/branch/Branches.ts, worker/Chat.ts `canAsk`), and every tool call runs as the remote flow `sandbox/Call`
// (worker/flows/SandboxCall.ts).

requires("personalModel", "member", "ownConversation")

const BRANCH = "/octocat/Spoon-Knife/tree/test-branch"

/** A machine's first wake builds nothing but may take a while on a cold machine. */
const MACHINE = 240_000

/** Every sandbox tool call this browser context sent to ChatApi: the engine worker's requests, observed. */
const toolCalls = (context: BrowserContext) => {
  const calls: Array<{ readonly tool: string; readonly callId: string }> = []
  context.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/sandbox/calls") return
    const body = request.postDataJSON() as { callId: string; call: { tool: string } }
    calls.push({ tool: body.call.tool, callId: body.callId })
  })
  return calls
}

const conversationOf = (page: Page) => page.getByRole("region", { name: "Conversation", exact: true })

/** Opens the fixture branch on `tab`, `search` appended, and waits for its workspace. */
const openBranch = async (tab: Tab, search = "") => {
  await tab.page.goto(`${BRANCH}${search}`)
  await expect(tab.page.getByRole("navigation", { name: "Branch" })).toContainText("test-branch", { timeout: 30_000 })
}

/** Asks Smithers `question` in the page's conversation. */
const ask = async (page: Page, question: string) => {
  const composer = page.getByRole("textbox", { name: "Message Smithers" })
  if (!(await composer.isVisible())) await page.getByRole("button", { name: /Chat/ }).click()
  await composer.fill(question)
  await composer.press("Enter")
  await expect(questionIn(conversationOf(page), question)).toBeVisible()
}

test("agent tools: the agent writes a file on the branch's machine, runs a test command and shows the diff", async ({ devices }) => {
  // The real model picks the tools: no scripted agent here.
  requires("liveModel")
  test.setTimeout(8 * 60_000)
  const word = devices.word
  const [a] = await devices.open("A")
  const tools = toolCalls(a.device.context)
  await openBranch(a)

  const file = `sandbox-${word}.txt`
  await ask(
    a.page,
    `Use the sandbox tools on this branch. Write the file ${file} with the single line: hello ${word}. ` +
      `Then run the command: grep -c ${word} ${file} && echo tests-passed-${word}. ` +
      `Then show me the diff tool's output verbatim in a code block.`,
  )
  const conversation = conversationOf(a.page)
  // The diff the agent shows is the machine's: the new file with its one line.
  await expect(messageIn(conversation, `+hello ${word}`).first()).toBeVisible({ timeout: MACHINE })
  // The agent's hands were the tools, each one call through ChatApi: write, run, diff.
  expect(tools.map((call) => call.tool)).toEqual(expect.arrayContaining(["write", "run", "diff"]))

  // The file is on the branch's machine, in the checkout the person's own terminal shows: one machine per branch.
  await a.page.goto(`${BRANCH}?terminal=me`)
  const rows = a.page.frameLocator('iframe[title="Terminal"]').locator("body")
  const open = a.page.getByRole("button", { name: "Open terminal" })
  await expect(async () => {
    if ((await open.isVisible()) && (await open.isEnabled())) await open.click()
    await expect(rows).toContainText("/workspace", { timeout: 15_000 })
  }).toPass({ timeout: MACHINE })
  await a.page.locator('iframe[title="Terminal"]').click()
  await a.page.keyboard.type(`cat ${file}; git status --short ${file}`)
  await a.page.keyboard.press("Enter")
  await expect(rows).toContainText(`hello ${word}`, { timeout: 30_000 })
  await expect(rows).toContainText(`?? ${file}`, { timeout: 30_000 })
})

test("closed tab: a command whose tab closed mid-run is recorded once, and the reopened tab reads its result", async ({ devices }) => {
  requires("scriptedAgent")
  test.setTimeout(8 * 60_000)
  const word = devices.word
  const [a] = await devices.open("A")
  const tools = toolCalls(a.device.context)
  await openBranch(a, scriptedAgent("sandbox-once", ""))

  // The scripted agent runs `sleep 15; echo ran >> runs-<word>.log; wc -l < runs-<word>.log` on the machine. Once
  // ChatApi has taken the call, the machine is running the command: close the tab, as a crash or a person would.
  const taken = a.page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/sandbox/calls" && response.status() === 202,
    { timeout: MACHINE },
  )
  await ask(a.page, `sandbox-count ${word}`)
  await taken
  await a.close()

  // The same browser opens the branch again: its engine resumes the answer's run from its journal, names the same
  // call, and reads the result the machine recorded, without running the command again.
  const b = await devices.tab(a.device, "A, reopened")
  await openBranch(b, scriptedAgent("sandbox-once", ""))
  await expect(messageIn(conversationOf(b.page), `Counted 1; the log has 1 line(s) for ${word}.`)).toBeVisible({ timeout: MACHINE })
  // Every request for the command named one call: the reopened tab's resend found the call the closed tab started.
  const runs = tools.filter((call) => call.tool === "run")
  expect(runs.length).toBeGreaterThanOrEqual(1)
  expect(new Set(runs.map((call) => call.callId)).size).toBe(1)
})

/**
 * How long the long command sleeps: just under ten minutes, the longest a command may run (600 s), unless
 * `E2E_LONG_COMMAND_SECONDS` says otherwise. It runs as its own `sandbox/Command` job through every real piece; a host
 * that dies mid-command is worker/flows/SandboxCommand.test.ts's, since `alchemy dev` never cuts an alarm off.
 */
const LONG_SECONDS = Number(process.env.E2E_LONG_COMMAND_SECONDS ?? 570)

test("long command: a ten-minute command on the branch's machine runs once, and its result arrives", {
  annotation: {
    type: "summary",
    description: "A command that runs for minutes holds no host while it runs: it runs once, and the agent reads what it printed.",
  },
}, async ({ devices }) => {
  test.setTimeout((LONG_SECONDS + 900) * 1000)
  const word = devices.word
  const [a] = await devices.open("A")
  const tools = toolCalls(a.device.context)
  const log = `runs-${word}.log`
  const conversation = conversationOf(a.page)
  // Locally the agent's model is scripted in the engine worker (`?agent=sandbox-long`); a deployment asks the real one.
  if (meets("scriptedAgent")) {
    await openBranch(a, scriptedAgent("sandbox-long", ""))
    await ask(a.page, `sandbox-long ${word} ${LONG_SECONDS}`)
    await expect(messageIn(conversation, `Ran done-5; the log has 1 line(s) for ${word}.`)).toBeVisible({
      timeout: (LONG_SECONDS + 600) * 1000,
    })
  } else {
    await openBranch(a)
    await ask(
      a.page,
      `Use the sandbox run tool exactly once, with timeoutSeconds 600, to run this command: ` +
        `sleep ${LONG_SECONDS}; echo ran >> ${log}; echo done-$((2+3))-${word}. ` +
        `Then read ${log} with the read tool and reply with its line count and what the command printed, verbatim.`,
    )
    await expect(messageIn(conversation, `done-5-${word}`).first()).toBeVisible({ timeout: (LONG_SECONDS + 600) * 1000 })
  }
  // One call ran the command, however many times its tab's engine asked for it: one call id.
  const runs = tools.filter((call) => call.tool === "run")
  expect(runs.length).toBeGreaterThanOrEqual(1)
  expect(new Set(runs.map((call) => call.callId)).size).toBe(1)

  // The machine ran it once: its log has one line, in the checkout the person's own terminal shows.
  await a.page.goto(`${BRANCH}?terminal=me`)
  const rows = a.page.frameLocator('iframe[title="Terminal"]').locator("body")
  const open = a.page.getByRole("button", { name: "Open terminal" })
  await expect(async () => {
    if ((await open.isVisible()) && (await open.isEnabled())) await open.click()
    await expect(rows).toContainText("/workspace", { timeout: 15_000 })
  }).toPass({ timeout: MACHINE })
  await a.page.locator('iframe[title="Terminal"]').click()
  await a.page.keyboard.type(`echo lines-$(wc -l < ${log})-$((40+2))`)
  await a.page.keyboard.press("Enter")
  await expect(rows).toContainText("lines-1-42", { timeout: 30_000 })
})

