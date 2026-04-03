"use client"

import type { ComponentProps, HTMLAttributes } from "react"
import { Streamdown } from "streamdown"

import { cn } from "@/lib/utils"

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant" | "system"
}

export function Message({ className, from, children, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "flex w-full",
        from === "user" ? "justify-end" : "justify-start",
        className
      )}
      data-from={from}
      {...props}
    >
      {children}
    </div>
  )
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export function MessageContent({ className, children, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-xl border bg-card px-3 py-2 text-sm shadow-sm",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type MessageResponseProps = Omit<ComponentProps<typeof Streamdown>, "children"> & {
  children: string
}

export function MessageResponse({ className, children, ...props }: MessageResponseProps) {
  return (
    <Streamdown
      className={cn(
        "size-full min-w-0 break-words [overflow-wrap:anywhere] [&&>*:first-child]:mt-0 [&&>*:last-child]:mb-0",
        className
      )}
      {...props}
    >
      {children}
    </Streamdown>
  )
}
