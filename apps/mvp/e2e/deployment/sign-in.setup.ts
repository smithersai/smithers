import { restorePersonalModel } from "../personal-model"
import { chromium, expect, request as requests, test as setup } from "@playwright/test"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEVICE_PERSON_HEADER } from "../../src/features/auth/contract"
import { baseURL, type Identity, OWN_BRANCH, type Place, readIdentity, sessionFiles, target } from "../target"
import { redactError, redactRequestErrors } from "../redact"
import { leaseProfile } from "./lease"
import { personOf, readJson, renewal, type SessionAnswer, sessionState, type StorageState, writePrivate } from "./session"

// The deployment project's setup (docs/infrastructure.md#against-a-deployment): it signs the test account in once and
// every test in the `deployment` project starts from that session (playwright.config.ts). It reuses the stored session
// while the deployment accepts it; otherwise it signs in the way a person does, through GitHub, from the test
// account's own browser profile, and keeps only the app's session cookie. It never records video or a trace: GitHub's
// pages stay out of every artifact. Then, for a Member or above, it asks for the fixtures' clones.

const origin = new URL(baseURL).origin
const files = sessionFiles(baseURL)
/** The GitHub account the deployment's tests sign in as (decision 0008): no other session is kept. */
const LOGIN = process.env.E2E_GITHUB_LOGIN ?? "codeplanesmithers"
/** That account's persistent browser profile, signed in to GitHub, on the machine that runs the setup. */
const PROFILE = process.env.E2E_GITHUB_PROFILE ?? join(homedir(), ".multi-e2e-profile")
/**
 * Public repositories specs browse, branch and run machines on, cloned once per deployment (`POST /api/repos`), and the
 * repository of the branch the run asks in (`OWN_BRANCH`).
 */
export const FIXTURE_REPOSITORIES = [{ owner: "octocat", name: "Spoon-Knife" }, { owner: OWN_BRANCH.owner, name: OWN_BRANCH.name }] as const

/** What the identity file holds beyond `Identity`: when the session was signed in, for `renewal`. */
type IdentityRecord = Identity & { readonly signedInAt: number; readonly checkedAt: number }

/** GitHub showed a page a person must answer (a password, a device code): the setup can't sign in unattended. */
class GitHubNeedsPerson extends Error {
  override readonly name = "GitHubNeedsPerson"
}

setup.describe.configure({ mode: "serial" })

/** A request context for the deployment, whose errors never carry its session cookie (e2e/redact.ts). */
const api = async (storageState: StorageState | string) => {
  const context = await requests.newContext({ baseURL: origin, storageState: storageState as never })
  redactRequestErrors(context)
  return context
}

/** Who `state` is signed in as, and whether the run may use it. */
const askSession = async (state: StorageState) => {
  const request = await api(state)
  try {
    const response = await request.get("/api/auth/session")
    expect(response.status(), "the deployment answers who a session is").toBe(200)
    const answer = (await response.json()) as SessionAnswer
    return { person: personOf(answer, LOGIN), personId: typeof answer.personId === "string" ? answer.personId : undefined }
  } finally {
    await request.dispose()
  }
}

/** Signs the test account in through GitHub from its profile and returns the app's session, which the profile drops. */
const signIn = async (): Promise<StorageState> => {
  const lease = await leaseProfile(PROFILE)
  try {
    const browser = await chromium.launchPersistentContext(lease.path, { headless: true })
    const host = new URL(origin).hostname
    try {
      // Signed out on this origin; the profile keeps GitHub's own session, which is what signs the account in.
      await browser.clearCookies({ domain: host })
      const page = await browser.newPage()
      // The profile must be the test account's before anything signs in: GitHub names the signed-in user on its pages.
      await page.goto("https://github.com/")
      const onGitHubAs = await page.locator('meta[name="user-login"]').getAttribute("content")
      if (onGitHubAs !== LOGIN) {
        throw new GitHubNeedsPerson(
          `The profile is signed in to GitHub as ${onGitHubAs || "nobody"}, not ${LOGIN}: open it once with a visible browser and sign in as ${LOGIN}.`,
        )
      }
      await page.goto(`${origin}/api/auth/sign-in?return=/app`)
      const onGitHub = () => new URL(page.url()).hostname === "github.com"
      if (onGitHub() && new URL(page.url()).pathname === "/login/oauth/authorize") {
        await page.locator('button[name="authorize"]').click()
        await page.waitForURL((url) => url.origin === origin, { timeout: 60_000 })
      }
      if (onGitHub()) {
        throw new GitHubNeedsPerson(
          `GitHub asks a person to sign ${LOGIN} in (${new URL(page.url()).pathname}): open the profile once with a visible browser, sign in, and run again.`,
        )
      }
      expect(new URL(page.url()).origin, "GitHub sends the browser back to the deployment").toBe(origin)
      const state = sessionState((await browser.cookies(origin)) as never, origin)
      if (state === undefined) throw new Error(`Signing in at ${origin} set no session cookie; the deployment's sign-in failed (see its sign_in records)`)
      // The stored file is the session's only copy: the profile, which GitHub's cookies live in, no longer holds it.
      await browser.clearCookies({ domain: host })
      return state
    } finally {
      await browser.close()
    }
  } finally {
    await lease.release()
  }
}

setup("sign in as the test account", async () => {
  expect(target, "the setup signs in to a deployment only (E2E_TARGET=deployment)").toBe("deployment")
  const stored = await readJson<StorageState>(files.session)
  const before = await readJson<IdentityRecord>(files.identity)
  const checked = stored === undefined ? undefined : await askSession(stored)
  const why = renewal({
    state: stored,
    person: checked?.person,
    signedInAt: before?.signedInAt,
    now: Date.now(),
    fresh: process.env.E2E_FRESH_SIGN_IN === "1",
  })
  let kept = { state: stored!, person: checked?.person, signedInAt: before?.signedInAt ?? Date.now() }
  if (why !== undefined) {
    // The session it replaces stays as it is: another run may hold it, and it ends when it expires.
    setup.info().annotations.push({ type: "sign-in", description: why })
    const state = await signIn().catch((error: unknown) => Promise.reject(redactError(error)))
    const fresh = await askSession(state)
    if ("refused" in fresh.person) throw new Error(`The new session can't be used: ${fresh.person.refused}`)
    await writePrivate(files.session, JSON.stringify(state, null, 2))
    kept = { state, person: fresh.person, signedInAt: Date.now() }
  }
  const person = kept.person
  if (person === undefined || "refused" in person) throw new Error("The stored session was kept without a usable person")
  const record: IdentityRecord = { origin, ...person, signedInAt: kept.signedInAt, checkedAt: Date.now() }
  await writePrivate(files.identity, JSON.stringify(record, null, 2))
  setup.info().annotations.push({ type: "identity", description: `${person.login} (${person.role ?? "no role"})` })
})

setup("personal model: save and Test when E2E_PERSONAL_MODEL_KEY is supplied", async () => {
  if (!process.env.E2E_PERSONAL_MODEL_KEY) {
    setup.info().annotations.push({ type: "personal model", description: "not configured: E2E_PERSONAL_MODEL_KEY is unset; model-dependent specs will skip" })
    return
  }
  const request = await api(files.session)
  try {
    await restorePersonalModel(request)
  } finally {
    await request.dispose()
  }
})

setup("fixture repositories are requested", async () => {
  const identity = readIdentity(files.identity)!
  if (identity.role === "guest" || identity.role === null) {
    setup.info().annotations.push({ type: "fixtures", description: `not requested: ${identity.login} is ${identity.role ?? "no role"}; a clone needs a Member` })
    return
  }
  const request = await api(files.session)
  try {
    for (const repository of FIXTURE_REPOSITORIES) {
      // A cookie's write names the person it expects (decision 0023), as the app's own requests do.
      const response = await request.post("/api/repos", { data: repository, headers: { origin, [DEVICE_PERSON_HEADER]: identity.personId } })
      // 202 started a clone; 200 one is running or done. Either way the fixture is the deployment's from now on.
      expect([200, 202], `the deployment takes the clone of ${repository.owner}/${repository.name}`).toContain(response.status())
      setup.info().annotations.push({ type: "fixtures", description: `${repository.owner}/${repository.name}: ${response.status()}` })
    }
  } finally {
    await request.dispose()
  }
})

setup("the run's own conversation is tracked", async () => {
  // A deployment run asks only here (e2e/target.ts `home`). Tracking reads the branch from the deployment's forge,
  // which needs its repository cloned; until it can, no place is written and asking tests report blocked. A place
  // written before stays: another run may be reading it, and tracking again is idempotent.
  const identity = readIdentity(files.identity)!
  const request = await api(files.session)
  try {
    const { owner, name, ref } = OWN_BRANCH
    // Track the branch as it is; make it first only when the forge has none. Code Storage answers a create of a branch
    // it already holds 503, not `exists` (2026-10-21), so creating first would fail every run after the first.
    const track = (create: boolean) =>
      request.post("/api/branches", {
        data: { owner, name, ref, ...(create ? { create } : {}) },
        headers: { origin, [DEVICE_PERSON_HEADER]: identity.personId },
      })
    const tracked = await track(false)
    const response = tracked.status() === 404 ? await track(true) : tracked
    const body = (await response.json().catch(() => ({}))) as { conversationId?: unknown; access?: unknown; shared?: unknown; code?: unknown }
    setup.info().annotations.push({ type: "own conversation", description: `${owner}/${name}@${ref}: ${response.status()} ${String(body.code ?? body.access ?? "")}` })
    if (!response.ok() || typeof body.conversationId !== "string") return
    // The branch must be the account's own and unshared, or its questions would reach other people.
    expect(body.access, `${owner}/${name}@${ref} is the test account's own branch`).toBe("owner")
    expect(body.shared, `${owner}/${name}@${ref} is shared with nobody`).toBeFalsy()
    const place: Place = { path: `/${owner}/${name}/tree/${ref}`, conversationId: body.conversationId }
    await writePrivate(files.conversation, JSON.stringify(place, null, 2))
  } finally {
    await request.dispose()
  }
})
