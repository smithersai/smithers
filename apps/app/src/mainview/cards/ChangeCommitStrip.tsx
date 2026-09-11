import { Commit } from "@smthrs/ui"
import type { ChangeReceipt } from "./tutorial2-agent_change-contract"

/** Only a backend-verified receipt reaches this projection. */
export const ChangeCommitStrip = ({ receipt }: { readonly receipt: ChangeReceipt }) => (
  <section aria-label="Resulting commit" data-base={receipt.base} data-commit={receipt.sha}>
    <Commit commit={{ hash: receipt.sha, message: receipt.subject }} />
    <ul aria-label="Changed files">{receipt.files.map(path => <li key={path}><code>{path}</code></li>)}</ul>
    <p>Parent <code>{receipt.parent}</code></p>
  </section>
)
