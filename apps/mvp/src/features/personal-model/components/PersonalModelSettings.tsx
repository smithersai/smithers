import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RelativeTime,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Snippet,
} from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { FormEvent } from "react"
import { MODEL_TIERS } from "../../model/contract"
import { CONNECTION_KINDS, type ConnectionKind, PROTOCOLS } from "../contract"
import {
  ACTIVE,
  ADD,
  BASE_URL,
  BASE_URL_PLACEHOLDER,
  CLAUDE_COMMAND,
  CLAUDE_PASTE,
  CLAUDE_RUN,
  COPY_CODE,
  COPY_COMMAND,
  KEY,
  KIND_LABEL,
  LINK,
  MOVE_DOWN,
  MOVE_UP,
  OPEN_OPENAI,
  PROTOCOL,
  PROTOCOL_LABEL,
  REMOVE,
  SAVE,
  TEST,
  TIER_LABEL,
  TIER_PURPOSE,
  TOKEN,
  YOUR_MODEL,
} from "../copy"
import type { PersonalModelRow } from "../schema"
import { addKind, busy, FIELDS, linkView, listOf, readAdd, rowDetail, rowStatusOf, type Status, statusOf, testable } from "../view"
import { usePersonalModel } from "./PersonalModelContext"
import "./personal-model-settings.css"

// Your model on /app/settings (decision 0132, docs/features/personal-model.md#the-settings-section): the person's ordered
// connections, as Amp's Model Routing. Each row is its kind and its host or last characters, Active, Move up, Move down,
// Test (not for a Claude subscription), Remove, and its refusal line; every press saves the whole list. Add opens a menu
// of the kinds, and each kind one small form in a dialog. A key is typed into a password field, read from the form once
// on Save and handed to the action; the dialog closes once ChatApi takes it. Someone signed in who may no longer save
// (`canSave` false) sees only Remove, while they have a connection saved.

function StatusLine({ status }: { readonly status: Status }) {
  return (
    <p role="status" className="personal-model-status">
      {status._tag === "Text" ? status.text : null}
      {status._tag === "Failure" ? <>{status.text} · <RelativeTime ts={status.at} /></> : null}
    </p>
  )
}

/** One field of an Add form: its label, and a text or password input. */
function TextField(
  { id, label, name, secret, placeholder, describedBy }: {
    readonly id: string
    readonly label: string
    readonly name: string
    readonly secret?: boolean
    readonly placeholder?: string
    readonly describedBy?: string
  },
) {
  return (
    <>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={secret === true ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
      />
    </>
  )
}

/** An API key's fields: its protocol, base URL, key and tiers' models. */
function ApiKeyFields() {
  return (
    <>
      <Field>
        <Label id="personal-model-protocol">{PROTOCOL}</Label>
        <Select name={FIELDS.protocol} defaultValue={PROTOCOLS[0]}>
          <SelectTrigger aria-labelledby="personal-model-protocol">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROTOCOLS.map((protocol) => <SelectItem key={protocol} value={protocol}>{PROTOCOL_LABEL[protocol]}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <TextField id="personal-model-base-url" label={BASE_URL} name={FIELDS.baseUrl} placeholder={BASE_URL_PLACEHOLDER} />
      </Field>
      <Field>
        <TextField id="personal-model-key" label={KEY} name={FIELDS.key} secret />
      </Field>
      {MODEL_TIERS.map((tier) => (
        <Field key={tier}>
          <TextField
            id={`personal-model-${tier}`}
            label={TIER_LABEL[tier]}
            name={FIELDS.model(tier)}
            describedBy={`personal-model-${tier}-purpose`}
          />
          <span id={`personal-model-${tier}-purpose`}>{TIER_PURPOSE[tier]}</span>
        </Field>
      ))}
    </>
  )
}

/** Claude's steps: run the command, paste what it prints. */
function ClaudeFields() {
  return (
    <ol className="personal-model-steps">
      <li>
        <span>{CLAUDE_RUN}</span>
        <Snippet code={CLAUDE_COMMAND} copyLabel={COPY_COMMAND} />
      </li>
      <li>
        <span>{CLAUDE_PASTE}</span>
        <TextField id="personal-model-key" label={TOKEN} name={FIELDS.key} secret />
      </li>
    </ol>
  )
}

/** Codex's form: Link, then the code, its copy button and where to type it, until the connection arrives. */
function CodexLink({ waiting }: { readonly waiting: boolean }) {
  const { queries, actions } = usePersonalModel()
  const { data: link } = useLiveQuery(queries.link)
  const shown = linkView(link)
  return (
    <div className="personal-model-form">
      {shown.code === undefined ? null : (
        <>
          <Snippet code={shown.code.userCode} copyLabel={COPY_CODE} />
          <a href={shown.code.verificationUrl} target="_blank" rel="noreferrer">{OPEN_OPENAI}</a>
        </>
      )}
      {shown.canLink ? <div className="personal-model-actions"><Button variant="solid" disabled={waiting} onClick={actions.link}>{LINK}</Button></div> : null}
      <p role="status" className="personal-model-status">{shown.status}</p>
    </div>
  )
}

/** A kind's form, read once on Save. */
function AddForm({ kind, status, waiting }: { readonly kind: ConnectionKind; readonly status: Status; readonly waiting: boolean }) {
  const { actions } = usePersonalModel()
  if (kind === "codex_subscription") return <CodexLink waiting={waiting} />
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    actions.add(readAdd(kind, (name) => String(data.get(name) ?? "")))
  }
  return (
    <form className="personal-model-form" aria-label={KIND_LABEL[kind]} onSubmit={submit}>
      {kind === "api_key" ? <ApiKeyFields /> : null}
      {kind === "claude_subscription" ? <ClaudeFields /> : null}
      {kind === "moonshot" || kind === "jev" ? <Field><TextField id="personal-model-key" label={KEY} name={FIELDS.key} secret /></Field> : null}
      <div className="personal-model-actions">
        <Button type="submit" variant="solid" disabled={waiting}>{SAVE}</Button>
      </div>
      <StatusLine status={status} />
    </form>
  )
}

/** One connection: what it is, its controls and its refusal line. */
function Connection(
  { row, rows, index, waiting }: {
    readonly row: PersonalModelRow
    readonly rows: ReadonlyArray<PersonalModelRow>
    readonly index: number
    readonly waiting: boolean
  },
) {
  const { queries, actions } = usePersonalModel()
  const { data: test } = useLiveQuery(queries.test)
  const name = `${KIND_LABEL[row.kind]} ${rowDetail(row)}`
  return (
    <li className="personal-model-row" aria-label={name}>
      <div className="personal-model-row-head">
        <p className="personal-model-row-name"><span>{KIND_LABEL[row.kind]}</span> {rowDetail(row)}</p>
        <div className="personal-model-actions">
          <Button
            size="sm"
            variant={row.active ? "secondary" : "ghost"}
            aria-pressed={row.active}
            disabled={waiting}
            onClick={() => actions.setActive(row.id, !row.active)}
          >
            {ACTIVE}
          </Button>
          <Button size="sm" variant="ghost" aria-label={MOVE_UP} disabled={waiting || index === 0} onClick={() => actions.move(row.id, -1)}>↑</Button>
          <Button size="sm" variant="ghost" aria-label={MOVE_DOWN} disabled={waiting || index === rows.length - 1} onClick={() => actions.move(row.id, 1)}>↓</Button>
          {testable(row)
            ? <Button size="sm" variant="outline" disabled={waiting} onClick={() => actions.test(row.id, { connections: listOf(rows) })}>{TEST}</Button>
            : null}
          <Button size="sm" variant="outline" disabled={waiting} onClick={() => actions.remove(row.id)}>{REMOVE}</Button>
        </div>
      </div>
      <StatusLine status={rowStatusOf(row, test)} />
    </li>
  )
}

export function PersonalModelSettings({ canSave }: { readonly canSave: boolean }) {
  const { queries, actions } = usePersonalModel()
  const { data: rows } = useLiveQuery(queries.saved)
  const { data: form } = useLiveQuery(queries.form)
  const { data: test } = useLiveQuery(queries.test)
  const { data: add } = useLiveQuery(queries.add)
  const status = statusOf(form, test)
  const waiting = busy(form, test)
  // Someone who may no longer save one, a person who lost their role, can still remove what they saved.
  if (!canSave) {
    if (rows.length === 0) return null
    return (
      <section className="personal-model" aria-label={YOUR_MODEL}>
        <h2>{YOUR_MODEL}</h2>
        <div className="personal-model-actions">
          <Button variant="outline" disabled={waiting} onClick={actions.removeAll}>{REMOVE}</Button>
        </div>
        <StatusLine status={status} />
      </section>
    )
  }
  const kind = addKind(add?.view)
  return (
    <section className="personal-model" aria-label={YOUR_MODEL}>
      <h2>{YOUR_MODEL}</h2>
      {rows.length === 0 ? null : (
        <ol className="personal-model-list" aria-label={YOUR_MODEL}>
          {rows.map((row, index) => <Connection key={row.id} row={row} rows={rows} index={index} waiting={waiting} />)}
        </ol>
      )}
      <div className="personal-model-actions">
        <Popover open={add?.view === "menu"} onOpenChange={(open) => actions.showAdd(open ? "menu" : "closed")}>
          <PopoverTrigger asChild>
            <Button variant="solid">{ADD}</Button>
          </PopoverTrigger>
          <PopoverContent align="start" aria-label={ADD}>
            <div className="personal-model-menu">
              {CONNECTION_KINDS.map((each) => (
                <Button key={each} size="sm" variant="ghost" onClick={() => actions.showAdd(each)}>{KIND_LABEL[each]}</Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {kind === undefined ? <StatusLine status={status} /> : null}
      <Dialog open={kind !== undefined} onOpenChange={(open) => (open ? undefined : actions.showAdd("closed"))}>
        {kind === undefined ? null : (
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{KIND_LABEL[kind]}</DialogTitle>
            </DialogHeader>
            <AddForm kind={kind} status={status} waiting={waiting} />
          </DialogContent>
        )}
      </Dialog>
    </section>
  )
}
