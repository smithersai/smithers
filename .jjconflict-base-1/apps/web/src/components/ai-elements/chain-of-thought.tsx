"use client"

import type { ComponentProps, ReactNode } from "react"
import { createContext, useContext, useMemo, useState } from "react"
import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

type ChainOfThoughtContextValue = {
  isStreaming: boolean
  isOpen: boolean
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(null)

function useChainOfThought() {
  const context = useContext(ChainOfThoughtContext)
  if (!context) {
    throw new Error("ChainOfThought components must be used within <ChainOfThought>")
  }
  return context
}

export type ChainOfThoughtProps = ComponentProps<"div"> & {
  isStreaming?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ChainOfThought({
  className,
  children,
  isStreaming = false,
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: ChainOfThoughtProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? true)
  const isOpen = open ?? internalOpen

  const contextValue = useMemo(
    () => ({
      isStreaming,
      isOpen,
    }),
    [isOpen, isStreaming]
  )

  return (
    <ChainOfThoughtContext.Provider value={contextValue}>
      <Collapsible
        className={cn("rounded-lg border bg-muted/20", className)}
        defaultOpen={defaultOpen ?? true}
        onOpenChange={(nextOpen) => {
          setInternalOpen(nextOpen)
          onOpenChange?.(nextOpen)
        }}
        open={open}
        {...props}
      >
        {children}
      </Collapsible>
    </ChainOfThoughtContext.Provider>
  )
}

export type ChainOfThoughtHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  title?: ReactNode
}

export function ChainOfThoughtHeader({
  className,
  children,
  title = "Chain of thought",
  ...props
}: ChainOfThoughtHeaderProps) {
  const { isStreaming, isOpen } = useChainOfThought()

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40",
        className
      )}
      {...props}
    >
      {isStreaming ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
      <span className="flex-1">{children ?? title}</span>
      <ChevronDownIcon className={cn("size-3 shrink-0 transition-transform", isOpen ? "rotate-180" : "")} />
    </CollapsibleTrigger>
  )
}

export type ChainOfThoughtContentProps = ComponentProps<typeof CollapsibleContent>

export function ChainOfThoughtContent({ className, children, ...props }: ChainOfThoughtContentProps) {
  return (
    <CollapsibleContent
      className={cn(
        "border-t px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
    </CollapsibleContent>
  )
}
