import { createContext, useContext } from "react"
import type { BillingView } from "../store.vibe"

const BillingContext = createContext<BillingView | null>(null)

export const BillingProvider = BillingContext.Provider

export const useBillingOptional = (): BillingView | null => useContext(BillingContext)
