import { Button, EmptyState, Field, Input, Label, RelativeTime, Textarea } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { FormEvent } from "react"
import { useAuth } from "../../auth/components/AuthContext"
import { useRepoAnswer } from "../../repo/components/RepoContext"
import { repoId } from "../../repo/contract"
import {
  ADD_SECRET,
  CANCEL,
  CANT_SEE,
  DELETE,
  DELETE_SECRET,
  failureText,
  HOSTS,
  LATE,
  NAME,
  ROTATE,
  rotateLabel,
  SAVE,
  SAVING,
  SECRETS,
  unknownText,
  VALUE,
} from "../copy"
import { formKey, type SecretForm } from "../schema"
import { accessOf, formOf, hostsText, onItsWay } from "../view"
import { useSecrets } from "./SecretsContext"

// A repository's secrets by name (docs/features/secrets.md#the-secrets-page): each one's hosts, methods and when it
// last changed, and for an Admin, Add, Rotate and Delete. A value is never shown: it is typed into a password field,
// read from the form once on submit and handed to the action, and the form clears as soon as ChatApi takes the write
// (its repository and `saved` count key it), then says Saving until the list shows it. A Maintainer or Member reads the
// list; anyone else sees that they can't.

/** The fields a submitted form holds, by name. */
const fieldsOf = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault()
  const data = new FormData(event.currentTarget)
  const field = (name: string) => String(data.get(name) ?? "")
  return { name: field("name"), value: field("value"), hosts: field("hosts") }
}

export function SecretsPage({ owner, repo }: { readonly owner: string; readonly repo: string }) {
  const { queries, actions } = useSecrets()
  const id = repoId(owner, repo)
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: rows } = useLiveQuery(queries.list(id))
  const { data: view } = useLiveQuery(queries.view)
  const { data: forms } = useLiveQuery(queries.forms)
  const answer = useRepoAnswer(owner, repo)
  const access = accessOf(session, answer)
  if (access === "loading") return null
  if (access === "none") return <EmptyState title={CANT_SEE} />
  const admin = access === "write"
  const added = formOf(forms, formKey(id, "add", ""))
  return (
    <>
      {admin
        ? (
          <form
            key={`${id}:${added?.saved ?? 0}`}
            className="secrets-add"
            aria-label={ADD_SECRET}
            onSubmit={(event) => {
              const fields = fieldsOf(event)
              actions.add(fields.name, fields.value, fields.hosts)
            }}
          >
            <Field>
              <Label htmlFor="secret-add-name">{NAME}</Label>
              <Input id="secret-add-name" name="name" required autoComplete="off" spellCheck={false} autoCapitalize="characters" />
            </Field>
            <Field>
              <Label htmlFor="secret-add-value">{VALUE}</Label>
              <Input id="secret-add-value" name="value" type="password" required autoComplete="off" />
            </Field>
            <Field>
              <Label htmlFor="secret-add-hosts">{HOSTS}</Label>
              <Textarea id="secret-add-hosts" name="hosts" required rows={2} code />
            </Field>
            <Submit form={added} label={ADD_SECRET} />
          </form>
        )
        : null}
      {rows.length === 0 ? <EmptyState title="No secrets" /> : null}
      <ul className="secrets-list" aria-label={SECRETS}>
        {rows.map((row) => {
          const rotating = admin && view?.repoId === id && view.rotating === row.name
          const deleting = admin && view?.repoId === id && view.deleting === row.name
          return (
            <li key={row.name}>
              <span className="secrets-name">{row.name}</span>
              <span className="secrets-hosts">{row.hosts.join(", ")}</span>
              {row.methods === null ? null : <span className="secrets-methods">{row.methods.join(" ")}</span>}
              <RelativeTime ts={Date.parse(row.updatedAt)} />
              {admin && !rotating && !deleting
                ? (
                  <span className="secrets-actions">
                    <Button variant="outline" size="sm" onClick={() => actions.startRotate(row.name)}>{ROTATE}</Button>
                    <Button variant="outline" size="sm" onClick={() => actions.startDelete(row.name)}>{DELETE}</Button>
                  </span>
                )
                : null}
              {rotating
                ? (
                  <form
                    key={formOf(forms, formKey(id, "rotate", row.name))?.saved ?? 0}
                    className="secrets-rotate"
                    aria-label={rotateLabel(row.name)}
                    onSubmit={(event) => {
                      const fields = fieldsOf(event)
                      actions.rotate(row.name, fields.value, fields.hosts)
                    }}
                  >
                    <Field>
                      <Label htmlFor="secret-rotate-value">{VALUE}</Label>
                      <Input id="secret-rotate-value" name="value" type="password" required autoComplete="off" />
                    </Field>
                    <Field>
                      <Label htmlFor="secret-rotate-hosts">{HOSTS}</Label>
                      <Textarea id="secret-rotate-hosts" name="hosts" required rows={2} code defaultValue={hostsText(row.hosts)} />
                    </Field>
                    <Submit form={formOf(forms, formKey(id, "rotate", row.name))} label={SAVE} />
                    <Button type="button" variant="ghost" onClick={actions.cancel}>{CANCEL}</Button>
                  </form>
                )
                : null}
              {deleting
                ? (
                  <span className="secrets-confirm">
                    <Submit
                      form={formOf(forms, formKey(id, "delete", row.name))}
                      label={DELETE_SECRET}
                      onClick={() => actions.remove(row.name)}
                    />
                    <Button type="button" variant="ghost" onClick={actions.cancel}>{CANCEL}</Button>
                  </span>
                )
                : null}
            </li>
          )
        })}
      </ul>
    </>
  )
}

/** A form's button, disabled while its write is on its way, and where the last one is. */
function Submit(props: { readonly form: SecretForm | undefined; readonly label: string; readonly onClick?: () => void }) {
  const form = props.form
  const saving = form !== undefined && onItsWay(form)
  return (
    <>
      <Button
        type={props.onClick === undefined ? "submit" : "button"}
        variant={props.onClick === undefined ? "default" : "destructive"}
        disabled={saving}
        onClick={props.onClick}
      >
        {props.label}
      </Button>
      {saving ? <span role="status">{SAVING}</span> : null}
      {form?.state === "late" ? <span role="status">{LATE}</span> : null}
      {form?.state === "unknown" ? <span role="alert">{unknownText(form.kind)}</span> : null}
      {form?.state === "failed" && form.failure !== null ? <span role="alert">{failureText(form.failure, form.secret)}</span> : null}
    </>
  )
}
