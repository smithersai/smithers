import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The factory seam (FactorySeam.ts) through the real command path:
 * /factory.show lists the repository root and `.smithers` through the public
 * contents route and surfaces the "factory" card. Every infra row is present,
 * absent or unreadable by what the tree answered; the wiki section states
 * the honest absence of a generated wiki and a Librarian log and counts the
 * notes the store holds. The model reads the same facts as a value.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

type Tree =
  | "full"
  | "no-flake"
  | "no-smithers-dir"
  | "root-500"
  | "root-500-no-smithers-dir"
  | "root-throw"
  | "root-404"
  | "root-file"

/**
 * The platform double: one mirrored repository (will/flows) answering the
 * FilesSeam wire shape for its root and its `.smithers` directory. The tree
 * variants remove a file, remove the `.smithers` directory, or make the root
 * listing fail, so the card pins each row's honest state.
 */
const backend = (tree: Tree = "full") => {
  const requests: Array<{ readonly method: string; readonly url: string }> = []
  const rootEntries = [
    { name: "PACKAGE.ts", path: "PACKAGE.ts", type: "file" },
    ...(tree === "no-flake" ? [] : [{ name: "flake.nix", path: "flake.nix", type: "file" }]),
    { name: ".smithers", path: ".smithers", type: "dir" },
    { name: "apps", path: "apps", type: "dir" },
    // No name: the seam derives one from the path's last segment.
    { path: "README.md", type: "file" },
    null
  ]
  const services: AppServices = {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not this seam's request.
      if (!url.endsWith("/contents/.smithers/factory.json")) requests.push({ method: init?.method ?? "GET", url })
      if (url === "/api/repos/will/flows/contents") {
        if (tree === "root-throw") throw new Error("socket hang up")
        if (tree === "root-500" || tree === "root-500-no-smithers-dir") return json(500, { message: "the mirror is rebuilding" })
        if (tree === "root-404") return json(404, { code: "not_found", message: "repository not found" })
        if (tree === "root-file") return json(200, { path: "", content: "", encoding: "base64", size: 0 })
        return json(200, rootEntries)
      }
      if (url === "/api/repos/will/flows/contents/.smithers") {
        if (tree === "no-smithers-dir" || tree === "root-500-no-smithers-dir") {
          return json(404, { message: "Path not found: .smithers" })
        }
        return json(200, [
          { name: "WORKSPACE.ts", path: ".smithers/WORKSPACE.ts", type: "file" },
          { name: "flows", path: ".smithers/flows", type: "dir" }
        ])
      }
      return json(404, { status: "error", message: `no stub for ${url}` })
    }
  }
  return { services, requests }
}

const freshController = async (tree?: Tree) => {
  const stub = backend(tree)
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    requests: stub.requests,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, stub.services)
  }
}

const identity = async (store: AppStore, state: "signed-in" | "signed-out"): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state,
    login: state === "signed-in" ? "will" : null,
    allowlisted: state === "signed-in",
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const reposLoaded = async (store: AppStore, catalog = false): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null, ...(catalog ? { catalog: true } : {}) }]
  })
  await settled()
}

const factoryCard = (store: AppStore, repo = "will/flows") => {
  const card = store.collections.cards.get(`factory-${repo}`)
  if (card === undefined || card.kind !== "factory") return undefined
  return card
}

describe("factory seam: factory.show", () => {
  test("lists the root and .smithers once each and marks every declared file present from the tree", async () => {
    const { store, controller, requests } = await freshController()
    await identity(store, "signed-in")
    await reposLoaded(store)
    const outcome = await controller.commands.run("factory.show")
    expect(outcome.status).toBe("executed")
    await settled()
    expect(requests.map((request) => request.url).sort()).toEqual([
      "/api/repos/will/flows/contents",
      "/api/repos/will/flows/contents/.smithers"
    ])
    const card = factoryCard(store)
    expect(card?.title).toBe("Factory · will/flows")
    expect(card?.payload.infra).toEqual([
      { path: ".smithers/WORKSPACE.ts", state: "present" },
      { path: "flake.nix", state: "present" },
      { path: "PACKAGE.ts", state: "present" }
    ])
  })

  test("a file the tree lacks is a row that says absent, never a dropped row", async () => {
    const { store, controller } = await freshController("no-flake")
    await identity(store, "signed-in")
    await reposLoaded(store)
    await controller.commands.run("factory.show")
    expect(factoryCard(store)?.payload.infra.map((row) => [row.path, row.state])).toEqual([
      [".smithers/WORKSPACE.ts", "present"],
      ["flake.nix", "absent"],
      ["PACKAGE.ts", "present"]
    ])
  })

  test("a repository with no .smithers directory lists its WORKSPACE.ts as absent", async () => {
    const { store, controller } = await freshController("no-smithers-dir")
    await identity(store, "signed-in")
    await reposLoaded(store)
    await controller.commands.run("factory.show")
    expect(factoryCard(store)?.payload.infra[0]).toEqual({ path: ".smithers/WORKSPACE.ts", state: "absent" })
  })

  test("the wiki section states no generated wiki, no Librarian log, and the notes the store holds", async () => {
    const { store, controller } = await freshController()
    await identity(store, "signed-in")
    await reposLoaded(store)
    const notes = store.collections.worldDocuments.size
    expect(notes).toBeGreaterThan(0)
    const outcome = await controller.commands.run("factory.show")
    expect(factoryCard(store)?.payload.wiki).toEqual({ generated: null, notes, librarian: null })
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") {
      expect(outcome.value).toBe(
        `Factory for will/flows: no generated wiki yet; ${notes} note${notes === 1 ? "" : "s"}; no Librarian answers recorded. ` +
          "Infra files: .smithers/WORKSPACE.ts present, flake.nix present, PACKAGE.ts present."
      )
    }
  })

  test("signed out, a catalog repository's factory still reads: the tree is public", async () => {
    const { store, controller, requests } = await freshController()
    await identity(store, "signed-out")
    await reposLoaded(store, true)
    const outcome = await controller.commands.run("factory.show")
    expect(outcome.status).toBe("executed")
    expect(requests).toHaveLength(2)
    expect(factoryCard(store)?.payload.infra).toHaveLength(3)
  })

  test("the agent's door reads the same card and the same value", async () => {
    const { store, controller } = await freshController("no-flake")
    await identity(store, "signed-in")
    await reposLoaded(store)
    const outcome = await controller.commands.runForAgent("factory.show")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") expect(outcome.value).toContain("flake.nix absent")
    expect(factoryCard(store)?.payload.infra[1]).toEqual({ path: "flake.nix", state: "absent" })
  })

  test("showing twice re-surfaces the one card at a later ordinal, never a second card", async () => {
    const { store, controller } = await freshController()
    await identity(store, "signed-in")
    await reposLoaded(store)
    await controller.commands.run("factory.show")
    const first = factoryCard(store)?.ordinal
    await controller.commands.run("factory.show")
    const cards = [...store.collections.cards.values()].filter((card) => card.kind === "factory")
    expect(cards).toHaveLength(1)
    expect(cards[0]?.ordinal).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY)
  })

  test("an explicit owner/repo argument targets that repository", async () => {
    const { store, controller, requests } = await freshController()
    await identity(store, "signed-in")
    await reposLoaded(store)
    const outcome = await controller.commands.run("factory.show", "acme/site")
    expect(outcome.status).toBe("executed")
    expect(requests.map((request) => request.url).sort()).toEqual([
      "/api/repos/acme/site/contents",
      "/api/repos/acme/site/contents/.smithers"
    ])
    // The stub knows no such tree: the root is not found, so the .smithers 404 is the same unread tree, not an absent file.
    const reason = "The repository tree could not be found on Smithers Cloud."
    expect(factoryCard(store, "acme/site")?.payload.infra).toEqual([
      { path: ".smithers/WORKSPACE.ts", state: "unreadable", reason },
      { path: "flake.nix", state: "unreadable", reason },
      { path: "PACKAGE.ts", state: "unreadable", reason }
    ])
  })

  test("with no repository loaded the repo-resolution error answers as-is and nothing is read", async () => {
    const { store, controller, requests } = await freshController()
    await identity(store, "signed-in")
    const outcome = await controller.commands.run("factory.show")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo")
    }
    expect(requests).toHaveLength(0)
  })
})

describe("factory seam: a root listing the backend refused", () => {
  test("a 500 marks the root rows unreadable with the backend's message and keeps the .smithers row", async () => {
    const { store, controller } = await freshController("root-500")
    await identity(store, "signed-in")
    await reposLoaded(store)
    const outcome = await controller.commands.run("factory.show")
    expect(outcome.status).toBe("executed")
    expect(factoryCard(store)?.payload.infra).toEqual([
      { path: ".smithers/WORKSPACE.ts", state: "present" },
      { path: "flake.nix", state: "unreadable", reason: "the mirror is rebuilding" },
      { path: "PACKAGE.ts", state: "unreadable", reason: "the mirror is rebuilding" }
    ])
  })

  test("a 500 root with a .smithers 404 marks the .smithers row unreadable with the root's reason, not absent", async () => {
    const { store, controller } = await freshController("root-500-no-smithers-dir")
    await identity(store, "signed-in")
    await reposLoaded(store)
    await controller.commands.run("factory.show")
    expect(factoryCard(store)?.payload.infra[0]).toEqual({
      path: ".smithers/WORKSPACE.ts",
      state: "unreadable",
      reason: "the mirror is rebuilding"
    })
  })

  test("a network throw is an unreadable row with an honest reason, never a throw", async () => {
    const { store, controller } = await freshController("root-throw")
    await identity(store, "signed-in")
    await reposLoaded(store)
    const outcome = await controller.commands.run("factory.show")
    expect(outcome.status).toBe("executed")
    expect(factoryCard(store)?.payload.infra[2]).toEqual({
      path: "PACKAGE.ts",
      state: "unreadable",
      reason: "Could not reach the backend to list the repository root in will/flows: socket hang up"
    })
  })

  test("a missing root is an unreadable tree, not three absent files", async () => {
    const { store, controller } = await freshController("root-404")
    await identity(store, "signed-in")
    await reposLoaded(store)
    await controller.commands.run("factory.show")
    const rows = factoryCard(store)?.payload.infra ?? []
    expect(rows.map((row) => row.state)).toEqual(["present", "unreadable", "unreadable"])
    expect(rows[1]?.reason).toBe("The repository tree could not be found on Smithers Cloud.")
  })

  test("a root that answers as a file is an unreadable tree with the shape named", async () => {
    const { store, controller } = await freshController("root-file")
    await identity(store, "signed-in")
    await reposLoaded(store)
    await controller.commands.run("factory.show")
    expect(factoryCard(store)?.payload.infra[1]).toEqual({
      path: "flake.nix",
      state: "unreadable",
      reason: "the repository root in will/flows did not answer as a directory."
    })
  })
})
