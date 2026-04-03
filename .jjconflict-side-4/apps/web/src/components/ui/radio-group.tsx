"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type RadioGroupContextValue = {
  name: string
  value?: string
  onValueChange?: (value: string) => void
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null)

type RadioGroupProps = Omit<React.ComponentProps<"div">, "onChange"> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
}

function RadioGroup({
  className,
  value,
  defaultValue,
  onValueChange,
  children,
  ...props
}: RadioGroupProps) {
  const generatedName = React.useId()
  const [internalValue, setInternalValue] = React.useState(defaultValue)

  const selectedValue = value ?? internalValue
  const handleChange = React.useCallback(
    (nextValue: string) => {
      if (value === undefined) {
        setInternalValue(nextValue)
      }
      onValueChange?.(nextValue)
    },
    [onValueChange, value]
  )

  return (
    <RadioGroupContext.Provider
      value={{
        name: generatedName,
        value: selectedValue,
        onValueChange: handleChange,
      }}
    >
      <div role="radiogroup" data-slot="radio-group" className={cn("grid gap-2", className)} {...props}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  )
}

type RadioGroupItemProps = Omit<React.ComponentProps<"input">, "type" | "name" | "onChange"> & {
  value: string
}

function RadioGroupItem({ className, value, ...props }: RadioGroupItemProps) {
  const context = React.useContext(RadioGroupContext)
  if (!context) {
    throw new Error("RadioGroupItem must be used inside RadioGroup")
  }

  return (
    <input
      data-slot="radio-group-item"
      type="radio"
      name={context.name}
      value={value}
      checked={context.value === value}
      onChange={() => context.onValueChange?.(value)}
      className={cn(
        "size-4 shrink-0 cursor-pointer appearance-none rounded-full border border-input text-primary outline-none transition-colors",
        "checked:border-primary checked:ring-2 checked:ring-primary/25",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { RadioGroup, RadioGroupItem }
