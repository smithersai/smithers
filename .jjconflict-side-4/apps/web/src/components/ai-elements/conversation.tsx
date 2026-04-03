"use client"

import type { ComponentProps, HTMLAttributes, ReactNode } from "react"
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDownIcon, MessageSquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ConversationContextValue = {
  contentRef: React.RefObject<HTMLDivElement | null>
  showScrollButton: boolean
  setShowScrollButton: (value: boolean) => void
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

const ConversationContext = createContext<ConversationContextValue | null>(null)

function useConversation() {
  const context = useContext(ConversationContext)
  if (!context) {
    throw new Error("Conversation components must be used within <Conversation>")
  }

  return context
}

export type ConversationProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: ReactNode
}

export function Conversation({ className, children, ...props }: ConversationProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const contentElement = contentRef.current
    if (!contentElement) {
      return
    }

    contentElement.scrollTo({
      top: contentElement.scrollHeight,
      behavior,
    })
  }

  const contextValue = useMemo<ConversationContextValue>(
    () => ({
      contentRef,
      showScrollButton,
      setShowScrollButton,
      scrollToBottom,
    }),
    [showScrollButton, setShowScrollButton]
  )

  return (
    <ConversationContext.Provider value={contextValue}>
      <div className={cn("relative flex h-full min-h-0 w-full min-w-0 flex-col", className)} {...props}>
        {children}
      </div>
    </ConversationContext.Provider>
  )
}

export type ConversationContentProps = ComponentProps<"div">

export function ConversationContent({ className, children, ...props }: ConversationContentProps) {
  const { contentRef, scrollToBottom, setShowScrollButton } = useConversation()

  useEffect(() => {
    scrollToBottom("auto")
  }, [children, scrollToBottom])

  return (
    <div
      className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4", className)}
      onScroll={(event) => {
        const node = event.currentTarget
        const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
        const shouldShowButton = distanceFromBottom > 72
        setShowScrollButton(shouldShowButton)
      }}
      ref={contentRef}
      {...props}
    >
      <div className="min-w-0 space-y-3">{children}</div>
    </div>
  )
}

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string
  description?: string
  icon?: ReactNode
}

export function ConversationEmptyState({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here.",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-[12rem] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center text-sm text-muted-foreground",
        className
      )}
      {...props}
    >
      {icon ?? <MessageSquareIcon className="size-8 text-muted-foreground/70" />}
      <p className="font-medium text-foreground">{title}</p>
      <p>{description}</p>
      {children}
    </div>
  )
}

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export function ConversationScrollButton({ className, onClick, ...props }: ConversationScrollButtonProps) {
  const { showScrollButton, scrollToBottom } = useConversation()

  if (!showScrollButton) {
    return null
  }

  return (
    <Button
      className={cn("absolute right-4 bottom-4 rounded-full", className)}
      onClick={(event) => {
        onClick?.(event)
        scrollToBottom()
      }}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  )
}
