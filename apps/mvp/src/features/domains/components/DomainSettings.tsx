import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  CopyButton,
  Field,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { FormEvent } from "react"
import {
  ADD,
  CERTIFICATE,
  CERTIFICATE_TEXT,
  COPY,
  DOMAIN_LABEL,
  DOMAIN_PLACEHOLDER,
  DOMAINS_HEADING,
  NAME,
  problemText,
  RECORDS_LABEL,
  REFRESH,
  refusalText,
  REMOVE,
  SAVING_TEXT,
  STATE_TEXT,
  STATE_TONE,
  TYPE,
  VALUE,
} from "../copy"
import type { Domain, DomainSave } from "../schema"
import { useDomains } from "./DomainsContext"
import "./domain-settings.css"

// A repository's custom domains (decision 0039, docs/features/domains.md#the-settings-section), as Vercel shows them:
// a field to add one, then one card per domain with its state, its certificate, the DNS records to add, Refresh and
// Remove. A write in flight, or why it didn't land, shows beside what it wrote. Only a Maintainer or Admin sees it.
export function DomainSettings() {
  const { queries, actions } = useDomains()
  const { data: domains } = useLiveQuery(queries.domains)
  const { data: saves } = useLiveQuery(queries.saves)
  const known = new Set(domains.map((domain) => domain.hostname))
  // A write of a hostname the list doesn't have yet is the add field's.
  const adding = saves.filter((save) => !known.has(save.hostname))
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    actions.add(String(new FormData(form).get("hostname") ?? ""))
    form.reset()
  }
  return (
    <section className="domain-settings" aria-label={DOMAINS_HEADING}>
      <Card>
        <CardHeader>
          <CardTitle>{DOMAINS_HEADING}</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="domain-settings-add" aria-label={`${ADD} ${DOMAIN_LABEL}`} onSubmit={submit}>
            <Field>
              <Label htmlFor="domain-hostname">{DOMAIN_LABEL}</Label>
              <Input
                id="domain-hostname"
                name="hostname"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                required
                placeholder={DOMAIN_PLACEHOLDER}
              />
            </Field>
            <Button type="submit" variant="solid">{ADD}</Button>
          </form>
          {adding.map((save) => (
            <p key={save.hostname} role="status" className="domain-settings-save" data-state={save.state}>
              <span className="domain-settings-host">{save.hostname}</span>{" "}
              {save.state === "saving" ? SAVING_TEXT[save.op] : refusalText(save.code)}
            </p>
          ))}
        </CardContent>
      </Card>
      {domains.map((domain) => (
        <DomainCard
          key={domain.hostname}
          domain={domain}
          save={saves.find((save) => save.hostname === domain.hostname)}
          onRefresh={actions.refresh}
          onRemove={actions.remove}
          onCopy={actions.copy}
        />
      ))}
    </section>
  )
}

function DomainCard(props: {
  readonly domain: Domain
  readonly save: DomainSave | undefined
  readonly onRefresh: (hostname: string) => void
  readonly onRemove: (hostname: string) => void
  readonly onCopy: (text: string) => Promise<void>
}) {
  const { domain, save } = props
  const busy = save?.state === "saving" || domain.state === "removing"
  const problem = problemText(domain.problem)
  return (
    <Card className="domain-card" aria-label={domain.hostname} data-state={domain.state}>
      <CardHeader>
        <CardTitle className="domain-settings-host">{domain.hostname}</CardTitle>
        <CardAction className="domain-card-actions">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => props.onRefresh(domain.hostname)}>
            {REFRESH}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => props.onRemove(domain.hostname)}>
            {REMOVE}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="domain-card-body">
        <div className="domain-card-status">
          <Badge variant={STATE_TONE[domain.state]}>{STATE_TEXT[domain.state]}</Badge>
          <span>{CERTIFICATE} · {CERTIFICATE_TEXT[domain.certificate]}</span>
          {save === undefined ? null : (
            <span role="status">{save.state === "saving" ? SAVING_TEXT[save.op] : refusalText(save.code)}</span>
          )}
        </div>
        {problem === null ? null : <p className="domain-card-problem">{problem}</p>}
        {domain.records.length === 0 || domain.state === "active" ? null : (
          <Table aria-label={RECORDS_LABEL} variant="plain">
            <TableHeader>
              <TableRow>
                <TableHead>{TYPE}</TableHead>
                <TableHead>{NAME}</TableHead>
                <TableHead>{VALUE}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domain.records.map((record) => (
                <TableRow key={`${record.type}:${record.name}`}>
                  <TableCell>{record.type}</TableCell>
                  <TableCell className="domain-record-value">{record.name}</TableCell>
                  <TableCell className="domain-record-value">
                    <span>{record.value}</span>
                    <CopyButton
                      variant="ghost"
                      size="sm"
                      aria-label={`${COPY} ${record.type} ${VALUE}`}
                      onCopy={() => props.onCopy(record.value)}
                    >
                      {COPY}
                    </CopyButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
