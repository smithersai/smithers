import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { ChoiceOption } from "@/features/workspaces/add-workspace/lib/models"

type ChoiceCardScreenProps<TValue extends string> = {
  value: TValue | null
  onChange: (value: TValue) => void
  options: ChoiceOption<TValue>[]
}

export function ChoiceCardScreen<TValue extends string>({
  value,
  onChange,
  options,
}: ChoiceCardScreenProps<TValue>) {
  return (
    <RadioGroup
      value={value ?? undefined}
      onValueChange={(nextValue: unknown) => {
        if (typeof nextValue === "string") {
          onChange(nextValue as TValue)
        }
      }}
      className="w-full gap-2"
    >
      {options.map((option) => (
        <FieldLabel key={option.value} htmlFor={`${option.value}-choice`} className="cursor-pointer">
          <Field orientation="horizontal" className="rounded-lg border px-3 py-2 transition-colors hover:bg-accent/30">
            <FieldContent>
              <FieldTitle>{option.title}</FieldTitle>
              <FieldDescription>{option.description}</FieldDescription>
            </FieldContent>
            <RadioGroupItem value={option.value} id={`${option.value}-choice`} />
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  )
}
