import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CardSchema } from "@smthrs/rpc/Cards"
import { ConnectCardBody } from "./ConversationCards"
import type { Card } from "../state/AppState"

for (const provider of [undefined, "local", "github"] as const) for (const connected of [false, true]) {
  test(`${provider ?? "legacy"} connector with connected=${connected} only offers the actual GitHub door`, () => {
    const card = CardSchema.parse({ id: "connect", kind: "connect", title: "Connect", status: "active", createdAt: 1, ordinal: 1,
      payload: { provider, github: { connected, login: connected ? "owner" : null }, nativeAvailable: false } }) as Extract<Card, {kind: "connect"}>
    const markup = renderToStaticMarkup(<ConnectCardBody card={card} onConnectGitHub={() => {}} onRunCommand={() => {}} />)
    expect(markup.includes("GitHub")).toBe(provider === "github")
    expect(markup.includes("Connected ✓ as")).toBe(provider === "github" && connected)
    expect(markup.includes('data-flow="auth.sign-in"')).toBe(provider === "github" && !connected)
    expect(markup).not.toContain("Issues, pull requests, and reviews")
  })
}
