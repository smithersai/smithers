import type { Page } from "@playwright/test"
import { writeHeaders } from "./target"

// A repository's stack route as the app's outbox calls it (docs/features/todos.md): specs that set lanes, commit
// TODOs to wait on, or drop what they committed use it directly. Each write names the person it expects.

/** The stack route's answer to `body`. */
export const stackChange = async (page: Pick<Page, "request">, repository: string, body: Record<string, unknown>) => {
  const response = await page.request.post(`/api/repos/${repository}/stack`, {
    data: { opId: crypto.randomUUID(), ...body },
    headers: writeHeaders(),
  })
  return {
    status: response.status(),
    body: (await response.json().catch(() => ({}))) as { readonly outcome?: string; readonly number?: number; readonly code?: string },
  }
}

/** Sets the stack's lanes and base, an Admin's change (decision 0135). */
export const configureStack = (page: Pick<Page, "request">, repository: string, lanes: number, base: "stacked" | "independent") =>
  stackChange(page, repository, { op: "configure", lanes, maxOpen: 200, base })

/** Drops TODO `number`, as a spec's cleanup: a TODO left open holds a stacked repository's later ones. */
export const dropTodo = (page: Pick<Page, "request">, repository: string, number: number) =>
  stackChange(page, repository, { op: "drop", number })

/** The TODO's state as the stack holds it (`GET /api/repos/<owner>/<name>/stack/<number>`), not as a device shows it. */
export const serverState = async (page: Pick<Page, "request">, repository: string, number: number | string) => {
  const response = await page.request.get(`/api/repos/${repository}/stack/${number}`)
  return response.ok() ? ((await response.json()) as { readonly state?: string }).state : `HTTP ${response.status()}`
}
