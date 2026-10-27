import { IssueForm } from "@smthrs/ui"
import type { ComponentProps } from "react"

const focusTitle = (form: HTMLFormElement | null) => {
  form?.querySelector<HTMLInputElement>("input")?.focus()
}

// Stable ref: a draft edit must never pull focus out of Description.
export function NewIssueForm(props: ComponentProps<typeof IssueForm>) {
  return <IssueForm {...props} ref={focusTitle} data-page-focus="" />
}
