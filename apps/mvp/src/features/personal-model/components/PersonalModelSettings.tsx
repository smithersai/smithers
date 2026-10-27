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
import { MODEL_TIERS } from "../../model/contract"
import { PROTOCOLS } from "../contract"
import {
  BASE_URL,
  BASE_URL_PLACEHOLDER,
  KEY,
  keyPlaceholder,
  PROTOCOL_LABEL,
  REMOVE,
  SAVE,
  TEST,
  TIER_LABEL,
  tierKeyLabel,
  YOUR_MODEL,
} from "../copy"
import { busy, FIELDS, keyOf, readForm, statusOf, tierView } from "../view"
import { usePersonalModel } from "./PersonalModelContext"
import "./personal-model-settings.css"

// Your model on /app/settings (decisions 0096 and 0107, docs/features/personal-model.md#the-settings-section): a
// signed-in Member or above saves a key per protocol (Base URL and Key, under the protocol's name) and the model each
// tier uses (Fast, Implement, Hard, each on one of the keys), so their own models answer them. Saved base URLs and named
// models show until edited; a tier left empty shows, as its placeholder, the model it uses anyway (a preset or the tier
// it falls back to). A key is typed into a password field, read from the form once on Save and handed to the action;
// the form clears once ChatApi takes it (`saved` keys the form). An empty key keeps the one saved at that base URL;
// clearing a base URL removes its key. Test and Remove show while a key is saved. One status line says what the last
// act did, or why a saved key last failed. Someone signed in who may no longer save (`canSave` false) sees only Remove,
// while they have a key saved.

/** An input that shows `synced` until the person edits it, and keeps an edit, and its focus, when `synced` changes. */
const follow = (synced: string) => (input: HTMLInputElement | null) => {
  if (input === null) return
  if (input.value === input.defaultValue) input.value = synced
  input.defaultValue = synced
}

export function PersonalModelSettings({ canSave }: { readonly canSave: boolean }) {
  const { queries, actions } = usePersonalModel()
  const { data: rows } = useLiveQuery(queries.saved)
  const { data: form } = useLiveQuery(queries.form)
  const { data: test } = useLiveQuery(queries.test)
  const status = statusOf(rows, form, test)
  const waiting = busy(form, test)
  // Someone who may no longer save one, a person who lost their role, can still remove the keys they saved.
  if (!canSave) {
    if (rows.length === 0) return null
    return (
      <section className="personal-model" aria-label={YOUR_MODEL}>
        <h2>{YOUR_MODEL}</h2>
        <div className="personal-model-actions">
          <Button type="button" variant="outline" disabled={waiting} onClick={actions.remove}>{REMOVE}</Button>
        </div>
        <p role="status" className="personal-model-status">{status._tag === "Text" ? status.text : null}</p>
      </section>
    )
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    actions.save(readForm((name) => String(data.get(name) ?? "")))
  }
  return (
    <section className="personal-model" aria-label={YOUR_MODEL}>
      <h2>{YOUR_MODEL}</h2>
      <form key={form?.saved ?? 0} className="personal-model-form" aria-label={YOUR_MODEL} onSubmit={submit}>
        {PROTOCOLS.map((protocol) => {
          const saved = keyOf(rows, protocol)
          return (
            <fieldset key={protocol} className="personal-model-key">
              <legend>{PROTOCOL_LABEL[protocol]}</legend>
              <Field>
                <Label htmlFor={`personal-model-${protocol}-base-url`}>{BASE_URL}</Label>
                <Input
                  id={`personal-model-${protocol}-base-url`}
                  name={FIELDS.baseUrl(protocol)}
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  placeholder={BASE_URL_PLACEHOLDER[protocol]}
                  ref={follow(saved?.baseUrl ?? "")}
                />
              </Field>
              <Field>
                <Label htmlFor={`personal-model-${protocol}-key`}>{KEY}</Label>
                <Input
                  id={`personal-model-${protocol}-key`}
                  name={FIELDS.key(protocol)}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  {...(saved === undefined ? {} : { placeholder: keyPlaceholder(saved.keyLast4) })}
                />
              </Field>
            </fieldset>
          )
        })}
        {MODEL_TIERS.map((tier) => {
          const shown = tierView(rows, tier)
          return (
            <Field key={tier} className="personal-model-tier">
              <Label htmlFor={`personal-model-${tier}`}>{TIER_LABEL[tier]}</Label>
              <div className="personal-model-tier-row">
                <Input
                  id={`personal-model-${tier}`}
                  name={FIELDS.model(tier)}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  {...(shown.placeholder === undefined ? {} : { placeholder: `Default: ${shown.placeholder}` })}
                  ref={follow(shown.model)}
                />
                {/* Keyed by the key it starts on: a save elsewhere shows at once. */}
                <Select key={shown.protocol} name={FIELDS.tierKey(tier)} defaultValue={shown.protocol}>
                  <SelectTrigger aria-label={tierKeyLabel(tier)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROTOCOLS.map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>{PROTOCOL_LABEL[protocol]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </Field>
          )
        })}
        <div className="personal-model-actions">
          <Button type="submit" disabled={waiting}>{SAVE}</Button>
          {rows.length === 0 ? null : (
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
