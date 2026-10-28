export type IssueSortOrder = "newest" | "oldest" | "updated"

/** Native sorting on the UI library's control metrics, including WebKit's native popup. */
export function IssueSort({ value, onChange }: { readonly value: IssueSortOrder; readonly onChange: (value: IssueSortOrder) => void }) {
  return <select className="sui-input" style={{ height: "var(--ctl-h, 32px)" }} aria-label="Sort" value={value}
    onChange={event => onChange(event.currentTarget.value as IssueSortOrder)}>
    <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="updated">Recently updated</option>
  </select>
}
