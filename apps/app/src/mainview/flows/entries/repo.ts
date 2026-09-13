/*
 * The `repo` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { text } from "../FlowForms"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `repo` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "repo", label: "Repository", summary: "Open and inspect local repositories" }

/** The repository starters, registered after `prs.*`. */
export const repoStarterFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * The repository welcome (controller/onboarding.ts): the opener a
   * repository shows when it is opened, and the three answers its buttons
   * are doors onto. Maintaining and contributing gate themselves on the
   * definitive signed-out answer: a human's invocation parks and renders the
   * sign-in step (auth.prompt), resuming as the signed-in user; the model's
   * invocation renders the step and fails honestly. Exploring is anonymous.
   */
  flow({
    name: "repo.welcome",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Welcome to the repository: what it is and how you can work on it",
    runtime: ["cloud"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: async ({ repo }) => {
      const welcome = await actions.welcomeRepo(repo)
      if (typeof welcome === "string") return welcome
      return actions.updateRepo(repo)
    }
  }),
  flow({
    name: "repo.maintain",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Maintain the repository: recent activity and the maintainer's reads",
    runtime: ["cloud"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: ({ repo }) => actions.maintainRepo(repo)
  }),
  flow({
    name: "repo.contribute",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Contribute to the repository: report an issue, sketch a feature, read the contributing guide",
    runtime: ["cloud"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: ({ repo }) => actions.contributeRepo(repo)
  }),
  flow({
    name: "repo.explore",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Explore the repository: its guide documents, then ask anything",
    runtime: ["cloud"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: ({ repo }) => actions.exploreRepo(repo)
  }),
  /*
   * The repository's home pane: the blocks its .smithers/FACTORY.ts declares
   * with `export const home = Smithers.Factory.Home`, projected to
   * .smithers/home.json and read from the public mirror. Anonymous, like
   * exploring; the welcome renders it above itself when the file exists.
   */
  flow({
    name: "repo.home",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Show the repository's home pane, the blocks its FACTORY.ts declares",
    runtime: ["cloud"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: ({ repo }) => actions.homeRepo(repo)
  })
]

/** The sidebar repository flows: select, unpin, tree. */
export const repoFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "repo.update", summary: "Check new issues, PR updates and repository status", args: "[owner/repo]", input: RepoTarget,
    handler: ({ repo }) => actions.updateRepo(repo) }),
  /* The sidebar's pinned repositories (docs/LOCAL-APP.md "Tabs"). */
  flow({
    name: "repo.select",
    summary: "Make a pinned repository the active one",
    runtimeAny: ["local.repositories", "cloud"],
    hidden: true,
    userOnly: true,
    userOnlyReason:
      "which pinned repository is active is the human's selection; an act names its working copy instead (tab.terminal [cwd])",
    args: "<repoKey>",
    input: Schema.Struct({ repo: Schema.String }),
    handler: ({ repo }) => actions.selectRepo(repo)
  }),
  flow({
    /* Forgets a repository: the agent asks, the human confirms. */
    name: "repo.unpin",
    summary: "Unpin a repository from the sidebar",
    runtime: ["local.repositories"],
    confirm: "unpin the repository",
    args: "<repoKey>",
    input: Schema.Struct({ repo: Schema.String }),
    handler: ({ repo }) => actions.unpinRepo(repo)
  }),
  /*
   * The sidebar's file tree (docs/workbench-lanes/sidebar-tree.md): a repo
   * row's caret expands the copy's root, a directory row its own path — the
   * row id grammar, `<copyId>#<path>`. Harmless, so every door has it; the
   * agent reads contents with files.list and files.read, the same route.
   */
  flow({
    name: "repo.tree",
    form: { args: (payload) => text(payload, "path") === undefined ? text(payload, "copy") ?? "" : `${text(payload, "copy")}#${text(payload, "path")}` },
    summary: "Expand or collapse a directory of a working copy (a local checkout or a cloud workspace) in the sidebar",
    /* A local checkout lists through the local app; a cloud workspace copy lists through Smithers Cloud (RepoTreeSeam). */
    runtimeAny: ["local.repositories", "cloud"],
    args: "<copyId>[#path]",
    input: Schema.Struct({ copy: Schema.String, path: Schema.optional(Schema.String) }),
    handler: ({ copy, path }) => actions.toggleRepoTree(copy, path)
  })
]

/** `repo.open`, registered last before the target flows. */
export const repoOpenFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * The chrome's "Open repository": the native folder dialog, or a typed
     * path. Granting the agent a directory is consequential, so a path it
     * names confirms; the dialog itself is the human's gesture, so without a
     * path the agent is told to name one (controller/tabs.ts openLocalRepo).
     */
    name: "repo.open",
    summary: "Open a local repository (a path, or the folder dialog)",
    runtime: ["local.repositories"],
    args: "[path]",
    confirm: ({ path }) => typeof path === "string" && path.trim() !== "" ? `open the local repository at ${path}` : undefined,
    input: Schema.Struct({ path: Schema.optional(Schema.String) }),
    handler: ({ path }) => actions.openLocalRepo(path)
  })
]

/** Root composes these after wiring the repository lane controller. */
export const tutorialRepositoryFlows = (actions: import("../../state/controller/tutorialRepository").TutorialRepositoryActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "repo.choose",
    summary: "Choose a repository by authored contributions in the last 90 days",
    args: "[owner/repo]", input: Schema.Struct({ repo: Schema.optional(Schema.String) }),
    handler: ({ repo }) => actions.chooseTutorialRepository(repo)
  }),
  flow({
    name: "repo.create",
    summary: "Create and open a local repository",
    args: "<name>", input: Schema.Struct({ name: Schema.String }),
    form: { fields: { name: { kind: "text" } } },
    confirm: "create and open a local repository",
    handler: ({ name }) => actions.createTutorialRepository(name)
  })
]
