import { Button } from "@smthrs/ui"
import type { FleetTab } from "../tab"

export function NavButton({ tab }: { readonly tab: FleetTab }) {
  return (
    <Button variant="link" className="fleet-nav" onClick={tab.actions.openGlobal}>
      Fleet
    </Button>
  )
}
