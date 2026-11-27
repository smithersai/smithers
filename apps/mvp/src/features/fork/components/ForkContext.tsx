import { createContext, useContext } from "react"
import type { ForkView } from "../store.vibe"

const ForkContext = createContext<ForkView | null>(null)

export const ForkProvider = ForkContext.Provider

export const useForkOptional = (): ForkView | null => useContext(ForkContext)
