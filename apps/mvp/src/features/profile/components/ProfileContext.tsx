import { createContext, useContext } from "react"
import type { ProfileView } from "../profile"

const ProfileContext = createContext<ProfileView | null>(null)

export const ProfileProvider = ProfileContext.Provider

export const useProfile = (): ProfileView => {
  const profile = useContext(ProfileContext)
  if (profile === null) throw new Error("useProfile needs a ProfileProvider: AppProviders.tsx renders one")
  return profile
}
