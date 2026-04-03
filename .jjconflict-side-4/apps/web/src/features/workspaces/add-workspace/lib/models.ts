import type { WorkspaceSourceType } from "@burns/shared"

export type WorkspaceRuntimeChoice = "burns-managed" | "self-managed"
export type ManagedWorkspaceSourceChoice = Extract<WorkspaceSourceType, "create" | "clone" | "local">

export type WizardStep = "runtime-choice" | "source-choice" | "final-config"

export type ChoiceOption<TValue extends string> = {
  value: TValue
  title: string
  description: string
}

export const runtimeChoiceOptions: ChoiceOption<WorkspaceRuntimeChoice>[] = [
  {
    value: "burns-managed",
    title: "Burns Managed",
    description: "Burns manages the lifecycle of a local Smithers.",
  },
  {
    value: "self-managed",
    title: "Self Managed",
    description: "Smithers runs externally and must expose an HTTP server.",
  },
]

export const managedSourceChoiceOptions: ChoiceOption<ManagedWorkspaceSourceChoice>[] = [
  {
    value: "create",
    title: "Create Repo",
    description: "Choose the folder where a Smithers-ready repo will be created.",
  },
  {
    value: "local",
    title: "Add Existing Repo",
    description: "Add Smithers to an existing repository.",
  },
  {
    value: "clone",
    title: "Clone a Repo",
    description: "Clone an existing repository and add Smithers to it.",
  },
]
