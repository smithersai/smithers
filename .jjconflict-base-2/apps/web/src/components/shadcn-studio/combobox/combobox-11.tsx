"use client"

import { useId, useMemo, useState } from "react"

import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export type Combobox11Option = {
  value: string
  label: string
}

type ComboboxMultipleProps = {
  className?: string
  label?: string
  placeholder?: string
  searchPlaceholder?: string
  emptyLabel?: string
  options: Combobox11Option[]
  selectedValues: string[]
  onChange: (nextValues: string[]) => void
}

const frameworks = [
  { value: "react", label: "React" },
  { value: "nextjs", label: "Nextjs" },
  { value: "angular", label: "Angular" },
  { value: "vue", label: "VueJS" },
  { value: "django", label: "Django" },
  { value: "astro", label: "Astro" },
  { value: "remix", label: "Remix" },
  { value: "svelte", label: "Svelte" },
  { value: "solidjs", label: "SolidJS" },
  { value: "qwik", label: "Qwik" },
] satisfies Combobox11Option[]

export function ComboboxMultiple({
  className,
  label = "Multiple combobox",
  placeholder = "Select framework",
  searchPlaceholder = "Search framework...",
  emptyLabel = "No framework found.",
  options,
  selectedValues,
  onChange,
}: ComboboxMultipleProps) {
  const id = useId()
  const [open, setOpen] = useState(false)

  const selectedLabelByValue = useMemo(() => {
    return new Map(options.map((option) => [option.value, option.label]))
  }, [options])

  const toggleSelection = (value: string) => {
    onChange(
      selectedValues.includes(value)
        ? selectedValues.filter((item) => item !== value)
        : [...selectedValues, value]
    )
  }

  const removeSelection = (value: string) => {
    onChange(selectedValues.filter((item) => item !== value))
  }

  return (
    <div className={cn("flex w-full max-w-xs flex-col gap-2", className)}>
      {label ? <Label htmlFor={id}>{label}</Label> : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="h-auto min-h-8 w-full justify-between hover:bg-transparent"
            />
          }
        >
          <div className="flex flex-wrap items-center gap-1 pr-2.5">
            {selectedValues.length > 0 ? (
              selectedValues.map((value) => {
                const selectedLabel = selectedLabelByValue.get(value)

                return selectedLabel ? (
                  <Badge key={value} variant="outline" className="rounded-sm">
                    {selectedLabel}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-4"
                      onClick={(event) => {
                        event.stopPropagation()
                        removeSelection(value)
                      }}
                      render={<span />}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </Badge>
                ) : null
              })
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </div>
          <ChevronsUpDownIcon className="shrink-0 text-muted-foreground/80" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent className="w-(--anchor-width) p-0">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyLabel}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => toggleSelection(option.value)}
                  >
                    <span className="truncate">{option.label}</span>
                    {selectedValues.includes(option.value) ? (
                      <CheckIcon className="ml-auto" size={16} />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export const Combobox11 = ComboboxMultiple

const ComboboxMultipleDemo = () => {
  const [selectedValues, setSelectedValues] = useState<string[]>(["react", "qwik"])

  return (
    <ComboboxMultiple
      label="Multiple combobox"
      placeholder="Select framework"
      searchPlaceholder="Search framework..."
      emptyLabel="No framework found."
      options={frameworks}
      selectedValues={selectedValues}
      onChange={setSelectedValues}
    />
  )
}

export default ComboboxMultipleDemo
