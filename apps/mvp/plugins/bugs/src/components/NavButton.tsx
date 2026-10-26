import { Button } from "@smthrs/ui"
import type { BugsTab } from "../tab"

// The header's entry: Report a bug opens the form; the report names the page it was pressed on.
export function NavButton({ tab }: { readonly tab: BugsTab }) {
  return (
    <Button variant="link" className="bugs-nav" onClick={tab.actions.report}>
      Report a bug
    </Button>
  )
}
