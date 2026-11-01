import type { Page } from "@playwright/test"
import { shapeRows } from "./shape"
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

/** A TODO as the stack's shape holds it, as much of it as a cleanup reads. */
type TodoRow = { readonly number: string; readonly title: string; readonly state: string }

/** The TODOs of `repository` still open, `only` those whose title has it: the stack's own answer, not a test's memory. */
const openTodos = async (page: Pick<Page, "request">, repository: string, only?: string) =>
  (await shapeRows<TodoRow>(page.request, `/api/shapes/todos?repo=${repository}&log=full`))
    .filter((todo) => todo.state !== "dropped" && todo.state !== "merged" && (only === undefined || todo.title.includes(only)))

/**
 * Drops every open TODO with `word` in its title. A commit whose answer was lost leaves a TODO no test has a number
 * for, and a Working one holds a lane from every test after it.
 */
export const dropWord = async (page: Pick<Page, "request">, repository: string, word: string) => {
  for (const todo of await openTodos(page, repository, word)) await dropTodo(page, repository, Number(todo.number))
}

/** A registered machine, as the fleet's shape holds it. */
type MachineRow = { readonly name: string; readonly removed_at: string | null }

/**
 * Puts a scratch repository back as a run needs it, through the product's own routes, and says what it found: no e2e
 * runner, no coding agent of one, no open TODO, one stacked lane. `pnpm e2e:prod` holds the test account's lock, so
 * nothing here is another run's: a run that was killed never reached its own cleanup, and its leavings would otherwise
 * hold the lane from every later test as a 60 s `queued` timeout.
 */
export const cleanScratch = async (page: Pick<Page, "request">, repository: string) => {
  const leftRunners = (await shapeRows<MachineRow>(page.request, `/api/shapes/machines?repo=${repository}&log=full`))
    .filter((machine) => machine.removed_at === null && machine.name.startsWith("e2e-"))
    .map((machine) => machine.name)
  const remove = async (path: string) => {
    const response = await page.request.delete(`/api/repos/${repository}/${path}`, { headers: writeHeaders() })
    if (response.status() !== 202) throw new Error(`DELETE ${path} answered ${response.status()}`)
  }
  // The agent first, so nothing new is handed to the runner going away.
  for (const name of leftRunners) await remove(`agents/${name}`)
  for (const name of leftRunners) await remove(`runners/${name}`)
  const leftTodos = await openTodos(page, repository)
  for (const todo of leftTodos) {
    const dropped = await dropTodo(page, repository, Number(todo.number))
    if (dropped.status !== 202) throw new Error(`dropping T${todo.number} answered ${dropped.status} ${dropped.body.code ?? ""}`)
  }
  const configured = await configureStack(page, repository, 1, "stacked")
  if (configured.status !== 202) throw new Error(`configuring the stack answered ${configured.status} ${configured.body.code ?? ""}`)
  return {
    runners: leftRunners,
    todos: leftTodos.map((todo) => `T${todo.number} ${todo.state}: ${todo.title}`),
  }
}
