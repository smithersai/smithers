import { Button, Field, Input, Label } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { FormEvent } from "react"
import { DEFAULT_SANDBOX_LIMITS, SANDBOX_LIMIT_BOUNDS, type SandboxLimits } from "../contract"
import { LIMIT_LABEL, LIMITS_HEADING, NOT_SAVED, SAVE, SAVING } from "../copy"
import { useSpend } from "./SpendContext"

// The sandbox limits (docs/features/sandbox-budgets.md#the-limits): an Admin's three numbers, saved together. The fields
// show the synced limits, or the defaults while none are set, until edited; a save that hasn't landed says so beside
// its button.
export function SandboxLimitsSettings() {
  const { queries, actions } = useSpend()
  const { data: rows } = useLiveQuery(queries.limits)
  const { data: saves } = useLiveQuery(queries.limitSaves)
  const [row] = rows
  const shown: SandboxLimits = row === undefined
    ? DEFAULT_SANDBOX_LIMITS
    : { awake: row.awake, perPerson: row.awakePerPerson, monthlyAlertUsd: row.monthlyAlertUsd }
  const [save] = saves
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const value = (name: keyof SandboxLimits) => Number(form.get(name))
    actions.setLimits({ awake: value("awake"), perPerson: value("perPerson"), monthlyAlertUsd: value("monthlyAlertUsd") })
  }
  return (
    <form className="sandbox-limits" aria-label={LIMITS_HEADING} onSubmit={submit}>
      <h2>{LIMITS_HEADING}</h2>
      {(["awake", "perPerson", "monthlyAlertUsd"] as const).map((name) => (
        <Field key={name}>
          <Label htmlFor={`sandbox-limit-${name}`}>{LIMIT_LABEL[name]}</Label>
          <Input
            id={`sandbox-limit-${name}`}
            name={name}
            type="number"
            inputMode="numeric"
            required
            step={1}
            min={SANDBOX_LIMIT_BOUNDS[name][0]}
            max={SANDBOX_LIMIT_BOUNDS[name][1]}
            ref={(input) => {
              if (input === null) return
              const synced = String(shown[name])
              // Refresh untouched fields in place, retaining any unsaved edit and its focus.
              if (input.value === input.defaultValue) input.value = synced
              input.defaultValue = synced
            }}
          />
        </Field>
      ))}
      <Button type="submit" disabled={save?.state === "saving"}>{SAVE}</Button>
      {save === undefined ? null : <span role="status">{save.state === "saving" ? SAVING : NOT_SAVED}</span>}
    </form>
  )
}
