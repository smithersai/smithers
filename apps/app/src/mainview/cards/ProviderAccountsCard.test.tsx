import { expect, test } from "bun:test"
import { isValidElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import { ProviderAccountsCardBody } from "./SecretsCard"

const limitedUntil = "2026-09-25T10:15:00Z"
const card = (pending?: { userCode: string; verificationUri: string }): Extract<Card, { kind: "provider-accounts" }> => ({
  id: "provider-accounts", kind: "provider-accounts", title: "Accounts", status: "active", createdAt: 0, ordinal: 0,
  payload: {
    accounts: [
      { id: "a", provider: "claude", label: "web-1", email: "ada@example.com", state: "active", limitedUntil: null },
      { id: "b", provider: "claude", label: "work", email: null, state: "active", limitedUntil },
      { id: "c", provider: "claude", label: "old", email: null, state: "refresh_failed", limitedUntil: null },
      { id: "x", provider: "codex", label: "codex", email: null, state: "active", limitedUntil: null }
    ],
    ...(pending ? { pending } : {})
  }
})

type Props = { children?: ReactNode; onClick?: () => void; disabled?: boolean; "data-flow"?: string; "data-flow-args"?: string }
const buttons = (node: ReactNode, found: Props[] = []): Props[] => {
  if (Array.isArray(node)) { node.forEach(child => buttons(child, found)); return found }
  if (!isValidElement<Props>(node)) return found
  if (node.props["data-flow"]) found.push(node.props)
  buttons(node.props.children, found)
  return found
}

test("rows read their state, limit and reconnect; buttons carry typed flow args", () => {
  const calls: Array<[string, string | undefined]> = []
  const body = ProviderAccountsCardBody({ card: card(), onRunCommand: (name, args) => { calls.push([name, args]) } })
  const html = renderToStaticMarkup(body)
  const at = new Date(Date.parse(limitedUntil))
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  expect(html).toContain(`limited until ${hhmm}`)
  expect(html).toContain("reconnect")
  expect(html).toContain("ada@example.com")
  expect(html).not.toContain("web-1")
  expect(html).toContain("Claude")
  expect(html).toContain("Codex")
  expect(html).not.toContain("codex-pending")
  const found = buttons(body)
  for (const button of found) if (!button.disabled) button.onClick?.()
  expect(found.slice(0, 2).map(button => button["data-flow"])).toEqual(["secrets.connect", "secrets.connect.codex"])
  expect(found.filter(button => button.disabled).map(button => button["data-flow-args"])).toEqual(["a up", "c down", "x up", "x down"])
  expect(calls).toEqual([
    ["secrets.connect", undefined], ["secrets.connect.codex", undefined],
    ["secrets.move", "a down"], ["secrets.revoke", "a"],
    ["secrets.move", "b up"], ["secrets.move", "b down"], ["secrets.revoke", "b"],
    ["secrets.move", "c up"], ["secrets.revoke", "c"],
    ["secrets.revoke", "x"]
  ])
})

test("a pending Codex sign-in shows its code and an Open link, nothing else", () => {
  const html = renderToStaticMarkup(ProviderAccountsCardBody({
    card: card({ userCode: "ABCD-EFGH", verificationUri: "https://auth.openai.com/codex/device" }), onRunCommand: () => {}
  }))
  const pending = /<p[^>]*data-testid="codex-pending"[^>]*>(.*?)<\/p>/.exec(html)?.[1] ?? ""
  expect(pending).toBe('<code>ABCD-EFGH</code> <a href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">Open</a>')
})
