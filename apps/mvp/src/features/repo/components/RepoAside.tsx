import { Button, EmptyState, RepoAbout } from "@smthrs/ui"
import { COULDNT_LOAD, INSTALL, RECLAIMABLE, TRY_AGAIN } from "../contract"
import type { AboutRow } from "../rows"
import type { Repository } from "../schema"
import { aboutOf, aboutProps, reclaimNoteOf } from "../view"

// The repository page's right column, as GitHub's: what GitHub says of the repository (`RepoAbout`), cloned or not, and
// under it, for a cloned copy storage may reclaim, the quiet note with Install, which opens the Smithers GitHub App's
// installation on GitHub.
export function RepoAside({ about, repository, onRetry }: {
  readonly about: AboutRow | undefined
  readonly repository: Repository | undefined
  readonly onRetry: () => void
}) {
  const note = reclaimNoteOf(repository, aboutOf(about))
  return (
    <RepoAbout
      {...aboutProps(about)}
      footer={about?.state !== "failed" && note === undefined ? undefined : <>
        {about?.state === "failed" ? <EmptyState title={about.message ?? COULDNT_LOAD} action={
          <Button variant="outline" size="sm" onClick={onRetry}>{TRY_AGAIN}</Button>
        } /> : null}
        {note === undefined ? null : (
          <p className="repo-reclaim" role="note">
            <span>{RECLAIMABLE}</span>
            {note.installUrl === null ? null : (
              <Button asChild variant="outline" size="sm">
                <a href={note.installUrl} target="_blank" rel="noopener noreferrer">{INSTALL}</a>
              </Button>
            )}
          </p>
        )}
      </>}
    />
  )
}
