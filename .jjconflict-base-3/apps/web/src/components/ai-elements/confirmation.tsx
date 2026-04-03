"use client"

import type { ComponentProps, ReactNode } from "react"
import { createContext, useContext, useMemo } from "react"

import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export type ConfirmationState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-denied"
  | "output-available"

export type ConfirmationApproval =
  | {
      id: string
      approved?: boolean
      reason?: string
    }
  | undefined

interface ConfirmationContextValue {
  approval: ConfirmationApproval
  state: ConfirmationState
}

const ConfirmationContext = createContext<ConfirmationContextValue | null>(null)

const useConfirmation = () => {
  const context = useContext(ConfirmationContext)

  if (!context) {
    throw new Error("Confirmation components must be used within Confirmation")
  }

  return context
}

export type ConfirmationProps = ComponentProps<typeof Alert> & {
  approval?: ConfirmationApproval
  state: ConfirmationState
}

export const Confirmation = ({ className, approval, state, ...props }: ConfirmationProps) => {
  const contextValue = useMemo(() => ({ approval, state }), [approval, state])

  if (!approval || state === "input-streaming" || state === "input-available") {
    return null
  }

  return (
    <ConfirmationContext.Provider value={contextValue}>
      <Alert className={cn("flex flex-col gap-3", className)} {...props} />
    </ConfirmationContext.Provider>
  )
}

export type ConfirmationTitleProps = ComponentProps<typeof AlertDescription>

export const ConfirmationTitle = ({ className, ...props }: ConfirmationTitleProps) => (
  <AlertDescription className={cn("font-medium text-foreground", className)} {...props} />
)

export interface ConfirmationRequestProps {
  children?: ReactNode
}

export const ConfirmationRequest = ({ children }: ConfirmationRequestProps) => {
  const { state } = useConfirmation()

  if (state !== "approval-requested") {
    return null
  }

  return children
}

export interface ConfirmationAcceptedProps {
  children?: ReactNode
}

export const ConfirmationAccepted = ({ children }: ConfirmationAcceptedProps) => {
  const { approval, state } = useConfirmation()

  if (
    !approval?.approved ||
    (state !== "approval-responded" && state !== "output-denied" && state !== "output-available")
  ) {
    return null
  }

  return children
}

export interface ConfirmationRejectedProps {
  children?: ReactNode
}

export const ConfirmationRejected = ({ children }: ConfirmationRejectedProps) => {
  const { approval, state } = useConfirmation()

  if (
    approval?.approved !== false ||
    (state !== "approval-responded" && state !== "output-denied" && state !== "output-available")
  ) {
    return null
  }

  return children
}

export type ConfirmationActionsProps = ComponentProps<"div">

export const ConfirmationActions = ({ className, ...props }: ConfirmationActionsProps) => {
  const { state } = useConfirmation()

  if (state !== "approval-requested") {
    return null
  }

  return <div className={cn("flex items-center justify-end gap-2", className)} {...props} />
}

export type ConfirmationActionProps = ComponentProps<typeof Button>

export const ConfirmationAction = (props: ConfirmationActionProps) => (
  <Button className="h-8 px-3 text-sm" type="button" {...props} />
)
