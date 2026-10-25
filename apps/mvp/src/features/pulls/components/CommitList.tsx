import "./changes.css"

// Commits, oldest first: each one's headline, author and short SHA. A pull request's Commits tab and a branch's Compare.
export function CommitList({ commits }: {
  readonly commits: ReadonlyArray<{ readonly sha: string; readonly headline: string; readonly author: string }>
}) {
  return (
    <ol className="commit-list" aria-label="Commits">
      {commits.map((commit) => (
        <li key={commit.sha} className="commit-list-item">
          <span className="commit-list-headline">{commit.headline}</span>
          {commit.author === "" ? null : <span>{commit.author}</span>}
          <code className="commit-list-sha">{commit.sha.slice(0, 7)}</code>
        </li>
      ))}
    </ol>
  )
}
