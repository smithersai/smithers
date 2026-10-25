import { Button, Field, Input, Label, Textarea } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import type { FormEvent, KeyboardEvent } from "react"
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "../../issues/contract"
import { pullPath } from "../../pulls/contract"
import type { Access } from "../contract"
import { DESCRIPTION, PUBLISH, publishBarOf, TITLE, UPDATE_BRANCH } from "../publishView"
import { useBranch } from "./BranchContext"
import "./publish.css"

// Publish and Update branch in the branch's chrome (rulings GH-6 and GH-11, docs/features/branch-publish.md#the-branch-page):
// a Smithers-only branch reaches GitHub only through Publish, whose inline form takes a title (the branch's name to
// start) and a description; Esc closes it. Once published: the pull request's link, Update branch, and Publish again,
// which pushes the working copy's new changes as one commit headed by its title (the pull request's to start). Beside
// each button, where its last write is, in a word or two.
export function PublishControls({ access }: { readonly access: Access | "none" | undefined }) {
  const { queries, publishing } = useBranch()
  const { data: current } = useLiveQuery(queries.current)
  const { data: publication } = useLiveQuery(publishing.queries.publication)
  const { data: pull } = useLiveQuery(publishing.queries.pullTitle)
  const { data: press } = useLiveQuery(publishing.queries.press)
  const { data: writes } = useLiveQuery(publishing.queries.writes)
  if (current === undefined) return null
  const bar = publishBarOf({ access, mode: current.mode, name: current.name, publication, pullTitle: pull?.title, press, writes })
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void publishing.actions.publish(String(form.get("title") ?? ""), String(form.get("body") ?? ""))
  }
  const escape = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return
    // The form's own Esc: the composer's shortcut doesn't also see it.
    event.stopPropagation()
    void publishing.actions.closeForm()
  }
  return (
    <span className="branch-publish">
      {bar.pull === undefined ? null : <Link to={pullPath(current.owner, current.repo, bar.pull)}>#{bar.pull}</Link>}
      {bar.publishStatus === undefined ? null : <span role="status" className="branch-publish-status">{bar.publishStatus}</span>}
      {bar.publish
        ? <Button variant="outline" disabled={bar.publishBusy} onClick={() => void publishing.actions.openForm()}>{PUBLISH}</Button>
        : null}
      {bar.updateStatus === undefined ? null : <span role="status" className="branch-publish-status">{bar.updateStatus}</span>}
      {bar.update
        ? <Button variant="outline" disabled={bar.updateBusy} onClick={() => void publishing.actions.update()}>{UPDATE_BRANCH}</Button>
        : null}
      {bar.form ? (
        <form className="branch-publish-form" aria-label={PUBLISH} onSubmit={submit} onKeyDown={escape}>
          <Field>
            <Label htmlFor="branch-publish-title">{TITLE}</Label>
            <Input id="branch-publish-title" name="title" defaultValue={bar.formTitle} required maxLength={MAX_TITLE_LENGTH} autoFocus />
          </Field>
          {bar.formDescription ? (
            <Field>
              <Label htmlFor="branch-publish-body">{DESCRIPTION}</Label>
              <Textarea id="branch-publish-body" name="body" rows={1} maxLength={MAX_BODY_LENGTH} />
            </Field>
          ) : null}
          <Button type="submit">{PUBLISH}</Button>
        </form>
      ) : null}
    </span>
  )
}
