import { createContext, useContext } from "react"
import type { PersonalModelView } from "../personalModel"

// What React components get: a person's own model's live queries to render and plain actions to call
// (features/personal-model/personalModel.ts).

const PersonalModelContext = createContext<PersonalModelView | null>(null)

export const PersonalModelProvider = PersonalModelContext.Provider

export const usePersonalModel = (): PersonalModelView => {
  const personalModel = useContext(PersonalModelContext)
  if (personalModel === null) throw new Error("usePersonalModel needs a PersonalModelProvider: main.tsx renders one")
  return personalModel
}
