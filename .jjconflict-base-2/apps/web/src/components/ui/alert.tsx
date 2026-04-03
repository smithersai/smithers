import type { HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="alert"
      className={cn(
        "relative w-full rounded-lg border border-border/70 bg-muted/20 px-4 py-3 text-sm text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />
}

export { Alert, AlertDescription }
