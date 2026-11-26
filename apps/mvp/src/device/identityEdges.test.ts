import { expect, test } from "vitest"
import { CONFIRM_401_HEADER, DEVICE_PERSON_HEADER, NO_DEVICE_DATA, SESSION_CHECK_HEADER } from "../features/auth/contract"
import { boundFetch, IDENTITY_MESSAGE, outboxPrincipal, readReceipt, reopenDue } from "./identity.vibe"
import { credentialAttempt, markSamePerson } from "./identityFetch"

// The owner check's failure edges a browser reaches only when its platform misbehaves: sessionStorage that refuses a
// read, and a Web Locks manager that breaks instead of granting or timing out. Each fake is a plain function.

const origin = "https://smithers.test"

test("storage that refuses a read never holds a reopen back", () => {
  const blocked = {
    getItem: (): string | null => {
      throw new Error("storage denied")
    },
    setItem: () => undefined,
  }
  expect(reopenDue(blocked, "reopen", 60_000, 0)).toBe(true)
})

test("a credential lock that breaks fails the write with the lock's error, unsent", async () => {
  let sent = 0
  const broken = new Error("lock manager unavailable")
  const transport = boundFetch(async () => {
    sent++
    return new Response(null, { status: 200 })
  }, { origin, principal: () => "alice", withCredential: () => Promise.reject(broken) })
  await expect(transport(`${origin}/api/questions`, { method: "POST", body: "{}" })).rejects.toBe(broken)
  expect(sent).toBe(0)
})

test("a credential lock that refuses publication keeps the stale refusal and holds every later write", async () => {
  let sent = 0
  let locks = 0
  const transport = boundFetch(async () => {
    sent++
    return new Response(null, { status: 503, headers: { "x-smithers-credential": "stale", "retry-after": "120" } })
  }, {
    origin,
    principal: () => "alice",
    withCredential: () => {
      locks++
      return Promise.reject(new Error("lock refused"))
    },
  })
  await expect(transport(`${origin}/api/repos`)).rejects.toMatchObject({ _tag: "DeviceIdentityRefused", reason: "credential_stale" })
  expect(sent).toBe(1)
  // The refused publication left its deadline unpublished: the write tries to publish it again, and is held unsent.
  await expect(transport(`${origin}/api/questions`, { method: "POST", body: "{}" })).rejects.toMatchObject({
    _tag: "DeviceIdentityRefused",
    reason: "credential_stale",
  })
  expect(sent).toBe(1)
  expect(locks).toBe(2)
})

test("a lock that fails as it releases a finished publication leaves the next write free to go", async () => {
  let stale = true
  let releases = 0
  const statuses: Array<number> = []
  const rows = new Map<string, string>()
  const transport = boundFetch(async () => {
    const response = stale
      ? new Response(null, { status: 503, headers: { "x-smithers-credential": "stale", "retry-after": "0" } })
      : new Response(null, { status: 200 })
    statuses.push(response.status)
    return response
  }, {
    origin,
    principal: () => "alice",
    credentialStorage: { get: async (key) => rows.get(key) ?? null, set: async (key, value) => void rows.set(key, value) },
    withCredential: async (action) => {
      const result = await action()
      if (releases++ === 0) throw new Error("lock release failed")
      return result
    },
  })
  await expect(transport(`${origin}/api/repos`)).rejects.toMatchObject({ reason: "credential_stale" })
  stale = false
  // The publication finished before its lock failed: its deadline is stored, and nothing stays held.
  await expect.poll(() => rows.size).toBe(1)
  const response = await transport(`${origin}/api/repos`)
  expect(response.status).toBe(200)
  expect(statuses).toEqual([503, 200])
})

const SESSION = "/api/auth/session"
const SIGN_OUT = "/api/auth/sign-out"
const stale = (retryAfter?: string) =>
  new Response(null, {
    status: 503,
    headers: { "x-smithers-credential": "stale", ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }) },
  })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const signedIn = (personId: string) => ({ signedIn: true, personId, login: personId, role: "member" })
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** A device store of credential fences, its writes held until `release` lets the oldest one through. */
const heldStorage = (initial: Record<string, string> = {}) => {
  const rows = new Map(Object.entries(initial))
  const waiting: Array<() => void> = []
  let open = false
  return {
    rows,
    waiting,
    release: () => waiting.shift()!(),
    open: () => {
      open = true
      while (waiting.length > 0) waiting.shift()!()
    },
    storage: {
      get: async (key: string) => rows.get(key) ?? null,
      set: async (key: string, value: string) => {
        if (!open) await new Promise<void>((resolve) => waiting.push(resolve))
        rows.set(key, value)
      },
    },
  }
}

test("a stale refusal without Retry-After stores a deadline already past", async () => {
  const held = heldStorage()
  held.open()
  const transport = boundFetch(async () => stale(), { origin, principal: () => "alice", credentialStorage: held.storage })
  await expect(transport(`${origin}/api/repos`)).rejects.toMatchObject({ reason: "credential_stale" })
  await expect.poll(() => held.rows.size).toBe(1)
  expect(JSON.parse(held.rows.get("outbox:credential:alice")!)).toMatchObject({ until: 0 })
})

test("a write waiting on publication is held while newer refusals keep extending the deadline", async () => {
  const held = heldStorage()
  const sent: Array<string> = []
  const transport = boundFetch(async (input) => {
    const request = new Request(input)
    sent.push(request.method)
    return stale("120")
  }, { origin, principal: () => "alice", credentialStorage: held.storage })
  await expect(transport(`${origin}/api/repos`)).rejects.toMatchObject({ reason: "credential_stale" })
  await expect.poll(() => held.waiting.length).toBe(1)
  let settled = false
  const write = transport(`${origin}/api/questions`, { method: "POST", body: "{}" }).finally(() => {
    settled = true
  })
  // A refusal while the first deadline is being stored extends it: the stored one is not the newest.
  await expect(transport(`${origin}/api/repos`)).rejects.toMatchObject({ reason: "credential_stale" })
  held.release()
  // The write's own publication stores the newer deadline, and another refusal extends it again meanwhile.
  await expect.poll(() => held.waiting.length).toBe(1)
  await expect(transport(`${origin}/api/repos`)).rejects.toMatchObject({ reason: "credential_stale" })
  expect(settled).toBe(false)
  held.open()
  await expect(write).rejects.toMatchObject({ _tag: "DeviceIdentityRefused", reason: "credential_stale" })
  expect(sent).toEqual(["GET", "GET", "GET"])
})

test("a lock lost while its publication stores the deadline lets that publication finish and retire", async () => {
  const rows = new Map<string, string>()
  let stored!: () => void
  const reading = new Promise<void>((resolve) => {
    stored = resolve
  })
  let lose!: (error: unknown) => void
  let readers = 0
  let refuse = true
  const transport = boundFetch(async () => (refuse ? stale("0") : new Response(null, { status: 200 })), {
    origin,
    principal: () => "alice",
    credentialStorage: {
      get: async (key) => {
        readers++
        await reading
        return rows.get(key) ?? null
      },
      set: async (key, value) => void rows.set(key, value),
    },
    withCredential: (action) => {
      void action()
      return new Promise((_resolve, reject) => {
        lose = reject
      })
    },
  })
  await expect(transport(`${origin}/api/repos`)).rejects.toMatchObject({ reason: "credential_stale" })
  await expect.poll(() => readers).toBe(1)
  lose(new Error("lock lost"))
  await tick()
  stored()
  await expect.poll(() => rows.size).toBe(1)
  refuse = false
  expect((await transport(`${origin}/api/repos`)).status).toBe(200)
})

test.each([
  { answer: "a 500", reread: () => new Response(null, { status: 500 }) },
  { answer: "a body that is not JSON", reread: () => new Response("not json", { status: 200 }) },
])("a held write whose session reread is $answer stays held, unsent", async ({ reread }) => {
  const sent: Array<string> = []
  const transport = boundFetch(async (input) => {
    const request = new Request(input)
    sent.push(new URL(request.url).pathname)
    return reread()
  }, {
    origin,
    principal: () => "alice",
    credentialStorage: heldStorage({ "outbox:credential:alice": JSON.stringify({ until: 0, revision: "r1" }) }).storage,
  })
  await expect(transport(`${origin}/api/questions`, { method: "POST", body: "{}" })).rejects.toMatchObject({
    _tag: "DeviceIdentityRefused",
    reason: "credential_stale",
  })
  expect(sent).toEqual([SESSION])
})

test("after this page's sign-out, a held write that finds the session ended fails without reopening", async () => {
  let reopens = 0
  const sent: Array<string> = []
  const transport = boundFetch(async (input) => {
    const request = new Request(input)
    const path = new URL(request.url).pathname
    sent.push(path)
    return path === SESSION ? json({ signedIn: false, available: true }) : new Response(null, { status: 200 })
  }, {
    origin,
    principal: () => "alice",
    credentialStorage: heldStorage({ "outbox:credential:alice": JSON.stringify({ until: 0, revision: "r1" }) }).storage,
    reauthorize: async () => {
      reopens++
      return true
    },
  })
  expect((await transport(`${origin}${SIGN_OUT}`, { method: "POST" })).status).toBe(200)
  await expect(transport(`${origin}/api/questions`, { method: "POST", body: "{}" })).rejects.toMatchObject({
    _tag: "DeviceIdentityRefused",
    reason: "signed_out",
  })
  expect(reopens).toBe(0)
  expect(sent).toEqual([SIGN_OUT, SESSION])
})

test("a reopen that fails fails every request that asked for it, and leaves the binding usable", async () => {
  let fail!: () => void
  const failing = new Promise<void>((resolve) => {
    fail = resolve
  })
  let checked = 0
  let person = "bob"
  const transport = boundFetch(async () => json(signedIn(person)), {
    origin,
    principal: () => "alice",
    reauthorize: () => failing.then(() => Promise.reject(new Error("reopen failed"))),
    reopensOnSignIn: () => {
      checked++
      return false
    },
  })
  const first = transport(`${origin}${SESSION}`)
  const second = transport(`${origin}${SESSION}`)
  // Both answers named someone else: both asked for the one reopen.
  await expect.poll(() => checked).toBe(2)
  fail()
  await expect(first).rejects.toThrow("reopen failed")
  await expect(second).rejects.toThrow("reopen failed")
  person = "alice"
  expect((await transport(`${origin}${SESSION}`)).status).toBe(200)
})

test("a damaged credential fence is repaired under its lock and verified before any write", async () => {
  let row = "{invalid"
  let locked = false
  const seen: string[] = []
  const transport = boundFetch(async (input) => {
    const request = new Request(input)
    seen.push(new URL(request.url).pathname)
    if (new URL(request.url).pathname === SESSION) return json(signedIn("alice"))
    expect(request.headers.get(DEVICE_PERSON_HEADER)).toBe("alice")
    return new Response(null, { status: 200 })
  }, {
    origin,
    principal: () => "alice",
    credentialStorage: {
      get: async () => {
        expect(locked).toBe(true)
        return row
      },
      set: async (_key, value) => {
        expect(locked).toBe(true)
        row = value
      },
    },
    withCredential: async (action) => {
      locked = true
      try {
        return await action()
      } finally {
        locked = false
      }
    },
  })

  expect((await transport(`${origin}/api/questions`, { method: "POST" })).status).toBe(200)
  expect(seen).toEqual([SESSION, "/api/questions"])
  expect(JSON.parse(row)).toEqual({ until: 0, revision: expect.any(String) })
})

test("the outbox reads the live principal and its legacy-write authority", () => {
  let owner: string | undefined
  let continuous = false
  const principal = outboxPrincipal(() => owner, () => continuous)
  expect(principal.now()).toBe(NO_DEVICE_DATA)
  expect(principal.ownsUnstamped()).toBe(false)
  owner = "alice"
  continuous = true
  expect(principal.now()).toBe("alice")
  expect(principal.ownsUnstamped()).toBe(true)
})

test("a drained credential publication retires without reading or writing storage", async () => {
  const operations: string[] = []
  await credentialAttempt({
    ready: Promise.resolve(),
    active: () => true,
    credentialKey: "outbox:credential:alice",
    pendingCredentials: new Map(),
    credentialStorage: {
      get: async () => {
        operations.push("get")
        return null
      },
      set: async () => { operations.push("set") },
    },
    previousGate: () => undefined,
    retire: () => { operations.push("retire") },
  })()
  expect(operations).toEqual(["retire"])
})

test("a session reread naming another person leaves the refusal unmarked and intact", async () => {
  const response = new Response("refused", { status: 401, headers: { "x-request-id": "1" } })
  const result = markSamePerson(response, SESSION_CHECK_HEADER, "alice", "bob")
  expect(result).toBe(response)
  expect(result.headers.get(SESSION_CHECK_HEADER)).toBeNull()
  expect(result.headers.get("x-request-id")).toBe("1")
  expect(await result.text()).toBe("refused")
})

test("a valid leader receipt keeps its verified session tag", () => {
  const receipt = { _tag: IDENTITY_MESSAGE, owner: "alice", outcome: "verified", sessionTag: "a".repeat(32) }
  expect(readReceipt(receipt)).toEqual(receipt)
})

test("a confirming 401 with an unavailable session stays queued as unchecked", async () => {
  const paths: string[] = []
  const transport = boundFetch(async (input) => {
    const request = new Request(input)
    const path = new URL(request.url).pathname
    paths.push(path)
    expect(request.headers.has(CONFIRM_401_HEADER)).toBe(false)
    if (path === SESSION) {
      expect(request.cache).toBe("no-store")
      return new Response(null, { status: 503 })
    }
    return new Response(null, { status: 401 })
  }, {
    origin,
    principal: () => "alice",
    reauthorize: async () => {
      throw new Error("an unavailable reread must not reopen")
    },
  })

  await expect(transport(`${origin}/api/questions`, {
    method: "POST",
    headers: { [CONFIRM_401_HEADER]: "1" },
  })).rejects.toMatchObject({ reason: "unchecked" })
  expect(paths).toEqual(["/api/questions", SESSION])
})
