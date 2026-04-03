"use client"

import type { ComponentProps, HTMLAttributes } from "react"

import type { LucideProps } from "lucide-react"
import { BookmarkIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

export type CheckpointProps = HTMLAttributes<HTMLDivElement>

export const Checkpoint = ({ className, children, ...props }: CheckpointProps) => (
  <div
    className={cn("flex items-center gap-2 overflow-hidden text-muted-foreground", className)}
    {...props}
  >
    {children}
    <Separator />
  </div>
)

export type CheckpointIconProps = LucideProps

export const CheckpointIcon = ({ className, children, ...props }: CheckpointIconProps) =>
  children ?? <BookmarkIcon className={cn("size-4 shrink-0", className)} {...props} />

export type CheckpointTriggerProps = ComponentProps<typeof Button> & {
  tooltip?: string
}

export const CheckpointTrigger = ({
  children,
  variant = "ghost",
  size = "sm",
  tooltip,
  ...props
}: CheckpointTriggerProps) => (
  <Button size={size} type="button" variant={variant} title={tooltip} {...props}>
    {children}
  </Button>
)
