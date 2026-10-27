import { expect, request as requests, type APIRequestContext } from "@playwright/test"
import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract"
import { baseURL, guard, sessionFiles, target } from "./target"

// Real prerequisite receipts, never a browser route replacement. A Member's read primes the shared About cache
// using the deployment read token before a visitor asks; an exhausted anonymous IP quota cannot establish absence.
export const repositoryAbout = async (kind: "absentRepository" | "unsyncedRepository") => {
  guard(kind)
  const repository = process.env[kind === "absentRepository" ? "E2E_ABSENT_REPOSITORY" : "E2E_UNSYNCED_REPOSITORY"]!
  const authenticated = await requests.newContext({ baseURL, ignoreHTTPSErrors: target === "local",
    ...(target === "deployment" ? { storageState: sessionFiles(baseURL).session } : {}) })
  try {
    const session = await authenticated.get("/api/auth/session")
    expect(session.status()).toBe(200)
    expect(await session.json()).toMatchObject({ signedIn: true })
    const response = await authenticated.get(`/api/repos/${repository}/about`)
    expect(response.status(), `${kind} requires an authoritative About receipt, never a quota refusal`).toBe(kind === "absentRepository" ? 404 : 200)
    if (kind === "absentRepository") expect(await response.json()).toMatchObject({ code: "not_found" })
    else expect(await response.json()).toMatchObject({ name: repository })
    return repository
  } finally { await authenticated.dispose() }
}

/** Complete a real clone before testing tree-to-file redirects, including the signed-out variant. */
export const mirroredFile = async (repository: string, path: string) => {
  const authenticated = await requests.newContext({ baseURL, ignoreHTTPSErrors: target === "local",
    ...(target === "deployment" ? { storageState: sessionFiles(baseURL).session } : {}) })
  try {
    const [owner, name] = repository.split("/")
    const clone = await authenticated.post("/api/repos", { data: { owner, name }, headers: await writes(authenticated) })
    expect(clone.ok(), "the real file prerequisite must be admitted").toBe(true)
    const { cloneId } = await clone.json() as { cloneId: string }
    const launch = await authenticated.post("/api/repos/launch", { data: { owner, name, cloneId }, headers: await writes(authenticated) })
    expect(launch.ok()).toBe(true)
    let sha: string | undefined
    await expect.poll(async () => {
      const refs = await authenticated.get(`/api/repos/${repository}/refs`)
      if (refs.status() === 204) return undefined
      expect(refs.status(), "the mirror prerequisite must resolve refs successfully").toBe(200)
      const body = await refs.json() as { branches: Array<{ name: string; sha: string }> }
      sha = body.branches.find(branch => branch.name === "main")?.sha
      return sha
    }, { timeout: 120_000, message: "a completed mirror with main is required for redirect coverage" }).toMatch(/^[a-f0-9]{40}$/)
    const tree = await authenticated.get(`/api/repos/${repository}/tree/${sha}`)
    expect(tree.status(), "the alias check needs a real completed file listing").toBe(200)
    expect((await tree.json() as { paths: string[] }).paths).toContain(path)
    const file = await authenticated.get(`/api/repos/${repository}/blob/${sha}/${path}`)
    expect(file.status(), "the redirect variant must name a real file at this mirror revision").toBe(200)
  } finally { await authenticated.dispose() }
}

const writes = async (request: APIRequestContext): Promise<Record<string, string>> => {
  if (target === "local") return {}
  const session = await request.get("/api/auth/session")
  expect(session.status()).toBe(200)
  const body = await session.json() as { signedIn: boolean; personId: string }
  expect(body.signedIn).toBe(true)
  expect(body.personId).toBeTruthy()
  return { origin: new URL(baseURL).origin, [DEVICE_PERSON_HEADER]: body.personId }
}
