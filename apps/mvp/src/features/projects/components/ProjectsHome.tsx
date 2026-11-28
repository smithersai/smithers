import { Button, Input } from "@smthrs/ui"
import { createContext, type ReactNode, useContext, useId, useSyncExternalStore } from "react"
import type { ProjectForm } from "../form.vibe"
import "../projects.css"

const ProjectFormContext = createContext<ProjectForm | undefined>(undefined)
export function ProjectFormProvider({ value, children }: { readonly value: ProjectForm | undefined; readonly children?: ReactNode }) {
  return <ProjectFormContext value={value}>{children}</ProjectFormContext>
}

export function ProjectsHome({ children }: { readonly children: ReactNode }) {
  const form = useContext(ProjectFormContext)
  return (
    <section className="projects-dashboard" aria-labelledby="projects-title">
      <header className="projects-heading">
        <h1 id="projects-title">Projects</h1>
      </header>
      {form !== undefined && <AccountForm form={form} />}
      {children}
    </section>
  )
}

function AccountForm({ form }: { readonly form: ProjectForm }) {
  const { projects } = form
  const [snapshot] = useSyncExternalStore(projects.subscribe, projects.current, projects.current)
  const personId = snapshot?.personId
  return personId === undefined ? null : <AddProject key={personId} form={form} personId={personId} />
}

const messages = {
  idle: "",
  invalid: "Enter a repository as owner/repository.",
  pending: "Adding project…",
  saved: "Project added.",
  sign_in: "Sign in again to add a project.",
  failed: "Couldn’t add project. Try again.",
} as const

function AddProject({ form, personId }: { readonly form: ProjectForm; readonly personId: string }) {
  const inputId = useId()
  const feedbackId = useId()
  const { draft } = form
  const row = useSyncExternalStore(draft.subscribe, draft.current, draft.current)
  const status = row.personId === personId ? row.status : "idle"
  const pending = status === "pending"
  return (
    <form className="projects-add" onSubmit={(event) => event.preventDefault()}>
      <label htmlFor={inputId}>Repository</label>
      <div className="projects-add-controls">
        <Input
          id={inputId}
          name="repository"
          placeholder="owner/repository"
          value={row.personId === personId ? row.text : ""}
          onChange={(event) => form.edit(personId, event.currentTarget.value)}
          required
          readOnly={pending}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={status === "invalid" || undefined}
          aria-describedby={feedbackId}
        />
        <Button type="submit" size="sm" disabled={pending} onClick={(event) => {
          // Enter in the input activates the default submit button through the browser too.
          event.preventDefault()
          if (event.nativeEvent.isTrusted && event.currentTarget.form?.reportValidity()) form.submit(personId)
        }}>Add project</Button>
        <Button type="button" size="sm" variant="outline" aria-label="Refresh projects" onClick={() => form.projects.refresh(personId)}>Refresh</Button>
      </div>
      <div id={feedbackId} className="projects-add-feedback" data-status={status} role="status">
        {messages[status]}
      </div>
    </form>
  )
}
