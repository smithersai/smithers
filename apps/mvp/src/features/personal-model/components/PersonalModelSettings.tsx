import {
  Button,
  Field,
  Input,
  Label,
  RelativeTime,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { FormEvent } from "react"
import { PROTOCOLS } from "../contract"
import {
  BASE_URL,
  BASE_URL_PLACEHOLDER,
  KEY,
  keyPlaceholder,
  MODEL,
  PROTOCOL,
  PROTOCOL_LABEL,
  REMOVE,
  SAVE,
  TEST,
  YOUR_MODEL,
} from "../copy"
import { busy, statusOf } from "../view"
import { usePersonalModel } from "./PersonalModelContext"
import "./personal-model-settings.css"

// Your model on /app/settings (decision 0096, docs/features/personal-model.md#the-settings-section): the protocol, base
// URL, model and key a signed-in Member or above saves, so their own model answers them. The first three fields show
// the saved values until edited; the key is typed into a password field, read from the form once on Save and handed to
// the action, and the form clears once ChatApi takes it (`saved` keys the form). Save always needs the key, so a saved
// key never goes to another host unless the person types it again. Test and Remove show while a model is saved. One
// status line says what the last act did, or why the saved key last failed.

/** An input that shows `synced` until the person edits it, and keeps an edit, and its focus, when `synced` changes. */
const follow = (synced: string) => (input: HTMLInputElement | null) => {
  if (input === null) return
  if (input.value === input.defaultValue) input.value = synced
  input.defaultValue = synced
}

export function PersonalModelSettings() {
  const { queries, actions } = usePersonalModel()
  const { data: row } = useLiveQuery(queries.row)
  const { data: form } = useLiveQuery(queries.form)
  const { data: test } = useLiveQuery(queries.test)
  const status = statusOf(row, form, test)
  const waiting = busy(form, test)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? "")
    actions.save(field("protocol"), field("baseUrl"), field("modelId"), field("key"))
  }
  return (
    <section className="personal-model" aria-label={YOUR_MODEL}>
      <h2>{YOUR_MODEL}</h2>
      <form key={form?.saved ?? 0} className="personal-model-form" aria-label={YOUR_MODEL} onSubmit={submit}>
        <Field>
          <Label htmlFor="personal-model-protocol">{PROTOCOL}</Label>
          {/* Keyed by the saved protocol: a save elsewhere shows at once. */}
          <Select key={row?.protocol ?? ""} name="protocol" defaultValue={row?.protocol ?? PROTOCOLS[0]}>
            <SelectTrigger id="personal-model-protocol">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROTOCOLS.map((protocol) => <SelectItem key={protocol} value={protocol}>{PROTOCOL_LABEL[protocol]}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <Label htmlFor="personal-model-base-url">{BASE_URL}</Label>
          <Input
            id="personal-model-base-url"
            name="baseUrl"
            type="text"
            inputMode="url"
            required
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            placeholder={BASE_URL_PLACEHOLDER}
            ref={follow(row?.baseUrl ?? "")}
          />
        </Field>
        <Field>
          <Label htmlFor="personal-model-model">{MODEL}</Label>
          <Input
            id="personal-model-model"
            name="modelId"
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            ref={follow(row?.modelId ?? "")}
          />
        </Field>
        <Field>
          <Label htmlFor="personal-model-key">{KEY}</Label>
          <Input
            id="personal-model-key"
            name="key"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            {...(row === undefined ? {} : { placeholder: keyPlaceholder(row.keyLast4) })}
          />
        </Field>
        <div className="personal-model-actions">
          <Button type="submit" disabled={waiting}>{SAVE}</Button>
          {row === undefined ? null : (
            <>
              <Button type="button" variant="outline" disabled={waiting} onClick={actions.test}>{TEST}</Button>
              <Button type="button" variant="outline" disabled={waiting} onClick={actions.remove}>{REMOVE}</Button>
            </>
          )}
        </div>
        <p role="status" className="personal-model-status">
          {status._tag === "Text" ? status.text : null}
          {status._tag === "Failure" ? <>{status.text} · <RelativeTime ts={status.at} /></> : null}
        </p>
      </form>
    </section>
  )
}
