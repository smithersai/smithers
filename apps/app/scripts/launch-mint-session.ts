/*
 * Wave 6: mint a Playwright storage state holding a REAL signed-in session,
 * through the identity worker's TEST-MODE GitHub OAuth flow (the dev stack
 * points identity at the stub GitHub double, so the callback seals a session
 * cookie for the fixture user without a browser). This is the
 * SMITHERS_MVP_STORAGE_STATE the launch checklist's receipt documents.
 *
 *   bun scripts/launch-mint-session.ts <identity-base-url> <app-origin> <out-path>
 *
 * Example:
 *   bun scripts/launch-mint-session.ts http://127.0.0.1:8861 http://localhost:8788 /tmp/mvp-storage-state.json
 */
import { writeFileSync } from "node:fs"

const [identityBase, appOrigin, outPath] = process.argv.slice(2)
if (identityBase === undefined || appOrigin === undefined || outPath === undefined) {
  console.error("usage: bun scripts/launch-mint-session.ts <identity-base-url> <app-origin> <out-path>")
  process.exit(2)
}

const appUrl = new URL(appOrigin)

const start = await fetch(`${identityBase}/api/auth/github/start`, { redirect: "manual" })
const location = start.headers.get("location")
if (start.status !== 302 || location === null) {
  console.error(`OAuth start answered ${start.status} with no redirect — is identity in TEST MODE?`)
  process.exit(1)
}
const state = new URL(location).searchParams.get("state")
if (state === null) {
  console.error(`OAuth start redirect carried no state param: ${location}`)
  process.exit(1)
}

const callback = await fetch(
  `${identityBase}/api/auth/github/callback?code=launch-mint&state=${encodeURIComponent(state)}`,
  { redirect: "manual" }
)
const setCookie = callback.headers.get("set-cookie")
if (callback.status !== 302 || setCookie === null) {
  console.error(`OAuth callback answered ${callback.status} with no session cookie`)
  process.exit(1)
}
const match = /^([^=]+)=([^;]*)/.exec(setCookie)
if (match === null) {
  console.error(`unparseable set-cookie: ${setCookie}`)
  process.exit(1)
}
const [, name, value] = match
const maxAge = /max-age=(\d+)/i.exec(setCookie)?.[1]

const storageState = {
  cookies: [
    {
      name: name as string,
      value: value as string,
      domain: appUrl.hostname,
      path: "/",
      expires: maxAge === undefined ? -1 : Math.floor(Date.now() / 1000) + Number(maxAge),
      httpOnly: /httponly/i.test(setCookie),
      secure: false,
      sameSite: /samesite=strict/i.test(setCookie) ? "Strict" : "Lax"
    }
  ],
  origins: []
}
writeFileSync(outPath, `${JSON.stringify(storageState, null, 2)}\n`)

// Prove the minted session against the real session route before declaring it.
const proof = await fetch(`${identityBase}/api/auth/session`, {
  headers: { cookie: `${name}=${value}` }
})
const session = (await proof.json()) as { login?: string; allowlisted?: boolean; admin?: boolean }
console.log(
  `minted session cookie '${name}' for ${appUrl.hostname} -> ${outPath}\n` +
    `session proof: HTTP ${proof.status} ${JSON.stringify(session)}`
)
if (session.login === undefined) {
  console.error("the minted cookie did not validate — refusing to call this a session")
  process.exit(1)
}
