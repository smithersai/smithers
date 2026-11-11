/**
 * The shared-mount contract in real Chromium: `BrowserHost.layer` over a ZenFS
 * in-memory volume, a real just-bash bound to it, and the `flows_jj.wasm`
 * reactor, bundled for and running in a tab. The page makes the observations
 * of `test/fixtures/SharedMountContract.ts`; this suite compares them.
 */
import type { BrowserContext, Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as SharedMountContract from "../fixtures/SharedMountContract.ts"
import * as Harness from "./Harness.ts"

/** `window.mountHarness` in `app/mount.ts`: one method per observation. */
type Observation = keyof typeof SharedMountContract.expected

let server: Awaited<ReturnType<typeof Harness.serve>> | undefined
let profile: ReturnType<typeof Harness.profile> | undefined
let context: BrowserContext | undefined
let page: Page

beforeAll(async () => {
  server = await Harness.serve({ mount: true })
  profile = Harness.profile()
  context = await Harness.launch(profile.directory)
  page = await context.newPage()
  await page.goto(`${server.origin}/mount`)
  await page.waitForFunction(() => "mountHarness" in globalThis)
})

afterAll(async () => {
  await context?.close()
  await server?.close()
  profile?.remove()
})

/** The page's observation `name`, as it posts it back. */
const observe = (name: Observation): Promise<unknown> =>
  page.evaluate(
    (name) => (globalThis as unknown as { mountHarness: Record<string, () => Promise<unknown>> }).mountHarness[name]!(),
    name
  )

describe("BrowserHost shared mount contract in Chromium", () => {
  it("shows one volume to FileSystem, the interpreter, and jj", async () => {
    expect(await observe("volume")).toEqual(SharedMountContract.expected.volume)
  })

  it("hides the interpreter's environment from a command unless the caller extends it", async () => {
    expect(await observe("environment")).toEqual(SharedMountContract.expected.environment)
  })

  it("aborts a running command on timeout and still runs the next one", async () => {
    expect(await observe("abort")).toEqual(SharedMountContract.expected.abort)
  })

  it("keeps the volume's own error codes as PlatformError tags", async () => {
    expect(await observe("errorTags")).toEqual(SharedMountContract.expected.errorTags)
  })
})
