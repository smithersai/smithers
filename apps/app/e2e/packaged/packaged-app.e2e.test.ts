import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, readdir, readFile, realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PackagedFixtureRun } from "./FixtureRun"
import type { PackagedTestFixture } from "./FixtureRun"
import { terminalExecutionProbe } from "../contracts/terminalExecutionProbe"
import { launchApp } from "./PackagedApp"
import type { PackagedApp } from "./PackagedApp"

const executable = process.env.SMITHERS_E2E_EXECUTABLE
const artifactsDirectory = process.env.SMITHERS_E2E_ARTIFACTS
const enabled = process.platform === "darwin" && executable !== undefined && artifactsDirectory !== undefined
const pluginFixture = fileURLToPath(new URL("../fixtures/repo-plugin/", import.meta.url))

// Durable account-owned fixture, verified through the saved
// codeplanesmithers profile. Tests pin and dirty only an isolated clone.
const githubFixture = {
  remote: "https://github.com/codeplanesmithers/canary-sandbox.git",
  revision: "340ecc0ee56893ec516de12e72468ffe9a2886f0",
  readme: "Smithers Cloud canary fixture repo."
} as const

let fixtureRun: PackagedFixtureRun | undefined

interface RenderedShell {
  readonly title: string
  readonly bodyTextLength: number
  readonly htmlLength: number
  readonly composer: boolean
  readonly transcript: boolean
}

interface RendererResponse<T> {
  readonly status: number
  readonly body: T
}

const renderedShell = `
  ({
    title: document.title,
    bodyTextLength: document.body?.innerText.length ?? 0,
    htmlLength: document.documentElement.outerHTML.length,
    composer: document.querySelector('[data-testid="composer-input"]') instanceof HTMLTextAreaElement,
    transcript: document.querySelector('[data-testid="transcript"]') instanceof HTMLElement
  })
`

const withApp = async (
  label: string,
  run: (app: PackagedApp, fixture: PackagedTestFixture) => Promise<void>
): Promise<void> => {
  if (executable === undefined || artifactsDirectory === undefined || fixtureRun === undefined) {
    throw new Error(
      "Run this suite through `bun run test:e2e` so it receives a packaged executable, artifacts, and fixture lease."
    )
  }
  const fixture = await fixtureRun.beginTest(label)
  const stateDirectory = await fixture.makeDirectory("application-state")
  let app: PackagedApp | undefined
  let failure: unknown
  try {
    app = await launchApp({ executable, artifactsDirectory, stateDirectory })
    await app.ready()
    await app.waitFor<RenderedShell>(renderedShell, (value) => value.composer && value.transcript)
    await run(app, fixture)
  } catch (error) {
    failure = error
    if (app !== undefined) {
      try {
        await app.captureDiagnostics(label)
      } catch (diagnosticError) {
        failure = new AggregateError([error, diagnosticError], `${label} failed and diagnostics could not be captured.`)
      }
    }
  }

  const cleanupFailures: Array<unknown> = []
  if (app !== undefined) {
    try {
      await app.cleanup()
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  // Do not erase fixture state while a packaged process may still own it.
  // The marker then blocks the next test and afterAll reports the leak.
  if (cleanupFailures.length === 0) {
    try {
      await fixture.cleanup()
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  const failures = [...(failure === undefined ? [] : [failure]), ...cleanupFailures]
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `${label} and its cleanup failed.`)
}

const selectorForTestId = (testId: string): string => `[data-testid=${JSON.stringify(testId)}]`

const clickSelector = async (app: PackagedApp, selector: string): Promise<void> => {
  await app.eval<boolean>(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!(element instanceof HTMLElement)) throw new Error(${JSON.stringify(`Missing clickable ${selector}`)})
      element.click()
      return true
    })()
  `)
}

const clickTestId = (app: PackagedApp, testId: string): Promise<void> => clickSelector(app, selectorForTestId(testId))

const setControlValue = async (app: PackagedApp, testId: string, value: string): Promise<void> => {
  await app.eval<boolean>(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selectorForTestId(testId))})
      if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
        throw new Error(${JSON.stringify(`Missing input ${testId}`)})
      }
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      if (setter === undefined) throw new Error('control value setter is missing')
      setter.call(element, ${JSON.stringify(value)})
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()
  `)
}

const sendMessage = async (app: PackagedApp, text: string): Promise<void> => {
  await setControlValue(app, "composer-input", text)
  await app.waitFor<boolean>(`
    (() => {
      const send = document.querySelector('[data-testid="composer-send"]')
      return send instanceof HTMLButtonElement && !send.disabled
    })()
  `)
  await clickTestId(app, "composer-send")
}

const transcriptContains = (text: string): string => `
  Array.from(document.querySelectorAll('.smithers-chat-message'))
    .some((element) => element.textContent?.includes(${JSON.stringify(text)}) === true)
`

const rendererApi = async <T>(
  app: PackagedApp,
  path: string,
  options: { readonly method?: string; readonly body?: unknown } = {}
): Promise<RendererResponse<T>> =>
  app.eval<RendererResponse<T>>(`
  (async () => {
    const token = document.querySelector('meta[name="smithers-local-session"]')?.getAttribute('content')
    if (token === null || token === undefined) throw new Error('local session token is missing')
    const headers = new Headers({ 'x-smithers-local-session': token })
    ${options.body === undefined ? "" : "headers.set('content-type', 'application/json')"}
    const response = await fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(options.method ?? "GET")},
      headers,
      ${options.body === undefined ? "" : `body: JSON.stringify(${JSON.stringify(options.body)}),`}
    })
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  })()
`)

const openRepository = async (app: PackagedApp, path: string | null): Promise<void> => {
  await app.queueRepositorySelection(path)
  const menuOpen = await app.waitFor<boolean>(
    `
    (() => {
      const trigger = document.querySelector('[data-testid="composer-repo-trigger"]')
      if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) return null
      return trigger.getAttribute('aria-expanded') === 'true'
    })()
  `,
    (value) => value !== null
  )
  if (!menuOpen) await clickTestId(app, "composer-repo-trigger")
  await app.waitFor<boolean>(`
    (() => {
      const button = document.querySelector('[data-testid="chrome-open-repo"]')
      return button instanceof HTMLButtonElement && !button.disabled && button.getBoundingClientRect().width > 0
    })()
  `)
  await clickTestId(app, "chrome-open-repo")
  // A successful native pick still has to be consumed and mirrored into the
  // renderer before subsequent commands can resolve the selected repository.
  if (path !== null && (await stat(path).catch(() => undefined))?.isDirectory()) {
    const selectedPath = await realpath(path)
    await app.waitFor<boolean>(`
      document.querySelector('[data-testid="repo-chip"]')?.getAttribute('title') === ${JSON.stringify(selectedPath)} &&
      Array.from(document.querySelectorAll('[data-testid^="repo-select-"]')).some((node) =>
        node.getAttribute('data-testid') === ${JSON.stringify(`repo-select-local:${selectedPath}`)})
    `)
  }
}

const runCommand = async (argv: ReadonlyArray<string>, cwd: string): Promise<string> => {
  const child = Bun.spawn([...argv], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const [code, out, err] = await Promise.all([child.exited, stdout, stderr])
  if (code !== 0) throw new Error(`${argv.join(" ")} failed with exit ${code}:\n${err}${out}`)
  return out.trim()
}

const cloneGitHubFixture = async (fixture: PackagedTestFixture): Promise<string> => {
  const destination = await fixture.makeDirectory("github-canary-sandbox")
  await runCommand(["git", "init", "--quiet"], destination)
  await runCommand(["git", "remote", "add", "origin", githubFixture.remote], destination)
  await runCommand(["git", "fetch", "--quiet", "--depth=1", "origin", "main"], destination)
  const revision = await runCommand(["git", "rev-parse", "FETCH_HEAD"], destination)
  if (revision !== githubFixture.revision) {
    throw new Error(`GitHub fixture moved: expected ${githubFixture.revision}, received ${revision}.`)
  }
  await runCommand(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], destination)
  if (!(await readFile(join(destination, "README.md"), "utf8")).includes(githubFixture.readme)) {
    throw new Error("The account-owned GitHub fixture README no longer matches its contract.")
  }
  for (const entry of await readdir(pluginFixture)) {
    await cp(join(pluginFixture, entry), join(destination, entry), { recursive: true, force: true })
  }
  return realpath(destination)
}

const typeInTerminal = async (app: PackagedApp, sessionId: string, data: string): Promise<void> => {
  await app.waitFor<boolean>(`
    document.querySelector('[data-testid="terminal-${sessionId}"] .xterm-helper-textarea') instanceof HTMLTextAreaElement
  `)
  await app.eval<boolean>(`
    (() => {
      const textarea = document.querySelector('[data-testid="terminal-${sessionId}"] .xterm-helper-textarea')
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Terminal input is not mounted')
      textarea.focus()
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: ${JSON.stringify(data)},
        inputType: 'insertText'
      }))
      return true
    })()
  `)
}

/* Enter is delivered on its own, so a test can prove echoed bytes alone run nothing. */
const submitTerminal = async (app: PackagedApp, sessionId: string): Promise<void> => {
  await app.eval<boolean>(`
    (() => {
      const textarea = document.querySelector('[data-testid="terminal-${sessionId}"] .xterm-helper-textarea')
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Terminal input is not mounted')
      textarea.focus()
      const key = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }
      textarea.dispatchEvent(new KeyboardEvent('keydown', key))
      textarea.dispatchEvent(new KeyboardEvent('keyup', key))
      return true
    })()
  `)
}

/** The PTY session's own byte stream, tail-limited, read through the renderer. */
const terminalOutput = (sessionId: string): string => `
  (async () => {
    const token = document.querySelector('meta[name="smithers-local-session"]')?.getAttribute('content') ?? ''
    const response = await fetch('/api/pty/${sessionId}/output?tail=16384', {
      headers: { 'x-smithers-local-session': token }
    })
    return response.ok ? (await response.json()).output : ''
  })()
`

/** The xterm grid as rendered rows, one line each, so a row can be matched whole. */
const terminalRows = (sessionId: string): string => `
  Array.from(document.querySelectorAll('[data-testid="terminal-${sessionId}"] .xterm-rows > div'))
    .map((row) => row.textContent ?? '')
    .join('\\n')
`

describe.skipIf(!enabled)("the packaged production Electrobun app", () => {
  beforeAll(async () => {
    fixtureRun = await PackagedFixtureRun.start({
      artifactsDirectory,
      ...(process.env.SMITHERS_E2E_FIXTURE_REGISTRY === undefined
        ? {}
        : { registryDirectory: process.env.SMITHERS_E2E_FIXTURE_REGISTRY }),
      allowStaleRecovery: process.env.SMITHERS_E2E_RECOVER_STALE === "1"
    })
  })

  afterAll(async () => {
    const run = fixtureRun
    fixtureRun = undefined
    await run?.cleanup()
  })

  test("launches the stable native renderer and exposes only an authenticated bridge", async () => {
    await withApp("launch", async (app) => {
      const state = await app.state()
      expect(state.app).toMatchObject({ packaged: true, channel: "stable", defaultRenderer: "native" })
      expect(state.window).toMatchObject({ renderer: "native", url: state.app.origin + "/" })
      expect(await app.unauthorizedStatus()).toBe(401)

      const shell = await app.waitFor<RenderedShell>(renderedShell, (value) => value.composer && value.transcript)
      expect(shell.title).toMatch(/Smithers/i)
      expect(shell.bodyTextLength).toBeGreaterThan(200)
      expect(shell.htmlLength).toBeGreaterThan(2_000)
      expect(await app.eval<number>("document.querySelectorAll('button').length")).toBeGreaterThan(3)
      await expect(app.eval("(() => { throw new Error('expected renderer failure') })()")).rejects.toThrow(
        "expected renderer failure"
      )
      expect(await app.eval<number>("6 * 7")).toBe(42)

      await sendMessage(app, "/appearance.theme")
      expect(await app.waitFor<boolean>(`document.querySelector('[data-testid="card-theme-picker"]') !== null`)).toBe(
        true
      )
      await clickTestId(app, "card-maximize-theme-picker")
      await clickTestId(app, "card-open-in-tab-theme-picker")
      expect(
        await app.waitFor<boolean>(
          `document.querySelector('[data-testid="tab-card-theme-picker"][data-active="true"]') !== null`
        )
      ).toBe(true)
      await clickTestId(app, "tab-close-card-theme-picker")
      expect(await app.waitFor<boolean>(`document.querySelector('[data-testid="tab-card-theme-picker"]') === null`))
        .toBe(true)
      expect(await app.eval<boolean>(`document.querySelector('[data-testid="card-theme-picker"]') !== null`)).toBe(true)

      const screenshot = await app.screenshot("launch.png").catch((error) => {
        expect(String(error)).toContain("screenshot_unavailable")
        return undefined
      })
      if (screenshot !== undefined) expect((await stat(screenshot)).size).toBeGreaterThan(100)
    })
  })

  test("round-trips chat, recovers from a rejected mutation, and persists through relaunch", async () => {
    await withApp("chat-persistence", async (app) => {
      const firstState = await app.state()
      const unauthorizedMutation = await app.eval<number>(`
        fetch(${JSON.stringify(`${firstState.app.origin}/api/chat/cancel`)}, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId: 'unauthorized-e2e-probe' })
        }).then((response) => response.status)
      `)
      expect(unauthorizedMutation).toBe(401)

      const message = `packaged app e2e ${crypto.randomUUID()}`
      await sendMessage(app, message)
      expect(await app.waitFor<boolean>(transcriptContains(message))).toBe(true)
      expect(await app.waitFor<boolean>(transcriptContains(`stub: ${message}`), (value) => value, 30_000)).toBe(true)
      await app.relaunch()
      const relaunchedState = await app.state()
      expect(relaunchedState.app.origin).toBe(firstState.app.origin)
      expect(relaunchedState.app.pid).not.toBe(firstState.app.pid)
      expect(await app.waitFor<boolean>(transcriptContains(message), (value) => value, 30_000)).toBe(true)
      expect(await app.waitFor<boolean>(transcriptContains(`stub: ${message}`), (value) => value, 30_000)).toBe(true)
    })
  })

  test("cancels and rejects bad native picks, then recovers by opening and closing a real directory", async () => {
    await withApp("repository-picker-recovery", async (app, fixture) => {
      await openRepository(app, null)
      await Bun.sleep(250)
      expect((await rendererApi<{ repos: Array<unknown> }>(app, "/api/repos")).body.repos).toEqual([])

      await openRepository(app, join(fixture.directory, "missing-repository"))
      expect(
        await app.waitFor<boolean>(
          `
        document.body.innerText.includes('cannot read and write this repository')
      `,
          (value) => value,
          15_000
        )
      ).toBe(true)
      expect((await rendererApi<{ repos: Array<unknown> }>(app, "/api/repos")).body.repos).toEqual([])

      const plain = await fixture.makeDirectory("plain-repository")
      await runCommand(["git", "init", "--quiet"], plain)
      await openRepository(app, plain)
      // Opening renders nothing; why a repository has no targets is /target.list's answer.
      expect(await app.eval<boolean>(`document.querySelector('.smithers-card[data-kind="repo"]') === null`)).toBe(true)
      await sendMessage(app, "/target.list")
      expect(await app.waitFor<boolean>(`document.body.innerText.includes('no WORKSPACE.ts')`)).toBe(true)
      expect(await app.eval<boolean>(`document.querySelector('.smithers-card[data-kind="targets"]') === null`)).toBe(
        true
      )

      const listed = await rendererApi<{ repos: Array<{ id: string; path: string; smithers: { detected: boolean } }> }>(
        app,
        "/api/repos"
      )
      expect(listed.status).toBe(200)
      expect(listed.body.repos).toHaveLength(1)
      expect(listed.body.repos[0]).toMatchObject({ path: await realpath(plain), smithers: { detected: false } })
      const closed = await rendererApi<{ ok: boolean }>(app, "/api/repo/close", {
        method: "POST",
        body: { repoId: listed.body.repos[0]?.id }
      })
      expect(closed).toEqual({ status: 200, body: { ok: true } })
      expect((await rendererApi<{ repos: Array<unknown> }>(app, "/api/repos")).body.repos).toEqual([])
    })
  })

  test("opens the account-owned GitHub clone through native RPC, runs its real target, and restores its pin", async () => {
    await withApp("github-target-persistence", async (app, fixture) => {
      const repository = await cloneGitHubFixture(fixture)
      const manual = await rendererApi<{ error: { code: string } }>(app, "/api/repo/open", {
        method: "POST",
        body: { path: repository }
      })
      expect(manual.status).toBe(403)
      expect(manual.body.error.code).toBe("manual_repository_paths_disabled")

      await openRepository(app, repository)
      await sendMessage(app, "/target.list")
      const targets = await app.waitFor<{ status: string; count: string; alert: string }>(
        `
        (() => {
          const body = document.querySelector('.smithers-card[data-kind="targets"] .targets-card')
          return {
            status: body?.getAttribute('data-status') ?? '',
            count: body?.querySelector('[data-testid="targets-count"]')?.textContent ?? '',
            alert: body?.querySelector('[role="alert"]')?.textContent ?? ''
          }
        })()
      `,
        (value) => value.status !== "" && value.status !== "pending",
        60_000
      )
      expect(targets).toEqual({ status: "done", count: "2 of 2", alert: "" })
      // The declared summary (the fixture's PACKAGE.ts `summary`) reads under the row's label.
      expect(
        await app.eval<string>(`document.querySelector('[data-testid="targets-summary-//:hello"]')?.textContent ?? ''`)
      )
        .toBe("Prints plugin-hello from the root workspace.")
      expect(
        await app.eval<string>(`document.querySelector('[data-testid="composer-repo-trigger"]')?.textContent ?? ''`)
      )
        .toContain("codeplanesmithers/canary-sandbox")

      const listed = await rendererApi<{
        repos: Array<{
          id: string
          path: string
          name: string
          git: { branch: string | null; remote: string }
          smithers: { detected: boolean; workspaces: Array<{ path: string }> }
        }>
      }>(app, "/api/repos")
      expect(listed.status).toBe(200)
      expect(listed.body.repos).toHaveLength(1)
      expect(listed.body.repos[0]).toMatchObject({
        path: repository,
        name: "codeplanesmithers/canary-sandbox",
        git: { branch: null, remote: githubFixture.remote },
        smithers: { detected: true, workspaces: [{ path: "." }, { path: "tools" }] }
      })

      await setControlValue(app, "targets-filter-query", "polish")
      expect(
        await app.waitFor<string>(
          `document.querySelector('[data-testid="targets-count"]')?.textContent ?? ''`,
          (value) => value === "1 of 2"
        )
      ).toBe("1 of 2")
      await setControlValue(app, "targets-filter-query", "")
      expect(
        await app.waitFor<string>(
          `document.querySelector('[data-testid="targets-count"]')?.textContent ?? ''`,
          (value) => value === "2 of 2"
        )
      ).toBe("2 of 2")
      await clickTestId(app, "targets-star-//:hello")
      expect(
        await app.waitFor<string>(
          `
        document.querySelector('[data-testid="targets-star-//:hello"]')?.getAttribute('aria-pressed') ?? ''
      `,
          (value) => value === "true"
        )
      ).toBe("true")

      await clickTestId(app, "targets-run-//:hello")
      const targetRun = await app.waitFor<{ status: string; text: string; output: string }>(
        `
        (() => {
          const cards = Array.from(document.querySelectorAll('.smithers-card[data-kind="target-run"]'))
          const card = cards[cards.length - 1]
          return {
            status: card?.querySelector('[data-run-status]')?.getAttribute('data-run-status') ?? '',
            text: card?.textContent ?? '',
            output: card?.querySelector('[data-testid^="target-run-output-"]')?.textContent ?? ''
          }
        })()
      `,
        (value) => value.status === "done" || value.status === "failed",
        90_000
      )
      expect(targetRun.status).toBe("done")
      expect(targetRun.text).toContain("exit 0")
      expect(targetRun.output).toContain("\"//:hello\",Shell.Test,ran")

      const beforeRelaunch = await app.state()
      await app.relaunch()
      expect((await app.state()).app.pid).not.toBe(beforeRelaunch.app.pid)
      // Native startup restores the user's remembered directory grants before
      // serving requests. Reusing the pin must not require another folder pick.
      const restored = await rendererApi<{ repos: Array<{ id: string; path: string; name: string }> }>(app, "/api/repos")
      expect(restored.status).toBe(200)
      expect(restored.body.repos).toEqual([
        expect.objectContaining({ path: repository, name: "codeplanesmithers/canary-sandbox" })
      ])
      const restoredRead = await rendererApi<{ kind: string }>(app, "/api/repo/files", {
        method: "POST",
        body: { repoId: restored.body.repos[0]!.id, path: "README.md" }
      })
      expect(restoredRead.status).toBe(200)
      expect(
        await app.waitFor<boolean>(`
        Array.from(document.querySelectorAll('.repo-name')).some((node) => node.textContent === 'codeplanesmithers/canary-sandbox')
      `)
      ).toBe(true)

      await clickTestId(app, `repo-select-local:${repository}`)
      expect(
        await app.waitFor<number>(
          `
        (async () => {
          const token = document.querySelector('meta[name="smithers-local-session"]')?.getAttribute('content') ?? ''
          const response = await fetch('/api/repos', { headers: { 'x-smithers-local-session': token } })
          return ((await response.json()).repos ?? []).length
        })()
      `,
          (value) => value === 1,
          30_000
        )
      ).toBe(1)
      expect(
        await app.waitFor<string>(
          `
        document.querySelector('[data-testid="targets-star-//:hello"]')?.getAttribute('aria-pressed') ?? ''
      `,
          (value) => value === "true",
          60_000
        )
      ).toBe("true")
    })
  })

  test("runs a real repository PTY, streams output into the native renderer, and deletes the session", async () => {
    await withApp("terminal-lifecycle", async (app, fixture) => {
      const repository = await fixture.makeDirectory("terminal-repository")
      await runCommand(["git", "init", "--quiet"], repository)
      await openRepository(app, repository)
      expect(await app.waitFor<boolean>(`document.querySelector('[data-testid="repo-chip"]') !== null`)).toBe(true)

      await clickTestId(app, "tab-add")
      await app.waitFor<boolean>(`document.querySelector('[data-testid="tab-add-terminal"]') !== null`)
      await clickTestId(app, "tab-add-terminal")
      const sessionId = await app.waitFor<string>(
        `
        document.querySelector('[data-testid^="terminal-"]')?.getAttribute('data-testid')?.replace(/^terminal-/, '') ?? ''
      `,
        (value) => value !== "",
        30_000
      )
      const created = await rendererApi<{
        sessions: Array<{ sessionId: string; kind: string; cwd: string; alive: boolean }>
      }>(app, "/api/pty")
      expect(created.status).toBe(200)
      expect(created.body.sessions).toEqual([
        expect.objectContaining({ sessionId, kind: "terminal", cwd: await realpath(repository), alive: true })
      ])

      // The probe's marker is printed as two quoted halves, so it is absent
      // from the typed command: echo cannot forge the execution evidence.
      const probe = terminalExecutionProbe(crypto.randomUUID().replaceAll("-", "").slice(0, 16))
      await typeInTerminal(app, sessionId, probe.command)
      const echoed = await app.waitFor<string>(terminalOutput(sessionId), probe.echoed, 30_000)
      // Enter has not been delivered yet: the bytes are echoed and nothing ran.
      expect(probe.echoed(echoed)).toBe(true)
      expect(probe.executed(echoed)).toBe(false)

      await submitTerminal(app, sessionId)
      const output = await app.waitFor<string>(terminalOutput(sessionId), probe.executed, 30_000)
      expect(probe.executed(output)).toBe(true)
      const rows = await app.waitFor<string>(terminalRows(sessionId), probe.executed, 30_000)
      expect(probe.executed(rows)).toBe(true)

      await clickTestId(app, `tab-close-${sessionId}`)
      expect(await app.waitFor<boolean>(`document.querySelector('[role="dialog"]') !== null`)).toBe(true)
      await app.eval<boolean>(`
        (() => {
          const button = Array.from(document.querySelectorAll('[role="dialog"] button'))
            .find((candidate) => candidate.textContent?.trim() === 'Close session')
          if (!(button instanceof HTMLButtonElement)) throw new Error('Missing Close session confirmation')
          button.click()
          return true
        })()
      `)
      expect(
        await app.waitFor<boolean>(
          `document.querySelector(${JSON.stringify(selectorForTestId(`tab-${sessionId}`))}) === null`
        )
      ).toBe(true)
      expect(
        await app.waitFor<number>(
          `
        (async () => {
          const token = document.querySelector('meta[name="smithers-local-session"]')?.getAttribute('content') ?? ''
          const response = await fetch('/api/pty', { headers: { 'x-smithers-local-session': token } })
          return ((await response.json()).sessions ?? []).length
        })()
      `,
          (value) => value === 0
        )
      ).toBe(0)

      await app.relaunch()
      expect(await app.waitFor<number>(`document.querySelectorAll('[data-testid^="tab-body-"]').length`)).toBe(1)
      expect((await rendererApi<{ sessions: Array<unknown> }>(app, "/api/pty")).body.sessions).toEqual([])
    })
  })
})
