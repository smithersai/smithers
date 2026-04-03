"use client"

import { type ReactNode } from "react"
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDashedIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"

export type OnboardingChecklistStep = {
  id: string
  title: string
  description: string
  completed: boolean
  content: ReactNode
}

type Onboarding01Props = {
  title: string
  subtitle: string
  steps: ReadonlyArray<OnboardingChecklistStep>
  openStepId: string | null
  onOpenStepChange: (stepId: string) => void
  headerAction?: ReactNode
}

function CircularProgress({
  completed,
  total,
}: {
  completed: number
  total: number
}) {
  const progress = total > 0 ? (completed / total) * 100 : 0
  const strokeDashoffset = 100 - progress

  return (
    <svg className="-rotate-90 scale-y-[-1]" height="14" width="14" viewBox="0 0 14 14">
      <circle
        className="stroke-muted"
        cx="7"
        cy="7"
        fill="none"
        r="6"
        strokeWidth="2"
        pathLength="100"
      />
      <circle
        className="stroke-primary"
        cx="7"
        cy="7"
        fill="none"
        r="6"
        strokeWidth="2"
        pathLength="100"
        strokeDasharray="100"
        strokeLinecap="round"
        style={{ strokeDashoffset }}
      />
    </svg>
  )
}

function StepIndicator({ completed }: { completed: boolean }) {
  if (completed) {
    return <CheckCircle2Icon className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" />
  }

  return (
    <CircleDashedIcon
      className="mt-1 size-4 shrink-0 text-muted-foreground/50"
      aria-hidden="true"
    />
  )
}

export function Onboarding01({
  title,
  subtitle,
  steps,
  openStepId,
  onOpenStepChange,
  headerAction,
}: Onboarding01Props) {
  const completedCount = steps.filter((step) => step.completed).length
  const remainingCount = steps.length - completedCount

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-3xl">
        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-xs">
          <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div className="flex flex-col gap-1">
              <h1 className="text-balance text-lg font-semibold text-foreground">{title}</h1>
              <p className="max-w-xl text-sm text-muted-foreground">{subtitle}</p>
            </div>
            <div className="flex items-center justify-end gap-3">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <CircularProgress completed={completedCount} total={steps.length} />
                <span>
                  <span className="font-medium text-foreground">{remainingCount}</span> of{" "}
                  <span className="font-medium text-foreground">{steps.length}</span> left
                </span>
              </div>
              {headerAction}
            </div>
          </div>

          <div className="flex flex-col gap-0">
            {steps.map((step, index) => {
              const isOpen = openStepId === step.id
              const isFirst = index === 0
              const previousStep = steps[index - 1]
              const isPreviousOpen = previousStep ? openStepId === previousStep.id : false
              const showBorderTop = !isFirst && !isOpen && !isPreviousOpen

              return (
                <div
                  key={step.id}
                  className={cn(
                    "group",
                    isOpen && "rounded-lg",
                    showBorderTop && "border-t border-border"
                  )}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenStepChange(step.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        onOpenStepChange(step.id)
                      }
                    }}
                    className={cn(
                      "block w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      isOpen && "rounded-lg"
                    )}
                  >
                    <div
                      className={cn(
                        "relative overflow-hidden rounded-lg transition-colors",
                        isOpen && "border border-border bg-muted"
                      )}
                    >
                      <div className="relative flex items-start justify-between gap-3 py-3 pl-4 pr-3">
                        <div className="flex w-full gap-3">
                          <div className="shrink-0">
                            <StepIndicator completed={step.completed} />
                          </div>
                          <div className="mt-0.5 grow">
                            <h2
                              className={cn(
                                "font-semibold",
                                step.completed ? "text-primary" : "text-foreground"
                              )}
                            >
                              {step.title}
                            </h2>
                            <Collapsible open={isOpen}>
                              <CollapsibleContent>
                                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                                  {step.description}
                                </p>
                                <div
                                  className="mt-4"
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => event.stopPropagation()}
                                >
                                  {step.content}
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          </div>
                        </div>
                        {!isOpen ? (
                          <ChevronRightIcon className="mt-1 shrink-0 text-muted-foreground" aria-hidden="true" />
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
