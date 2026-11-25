import { renderToStaticMarkup } from "react-dom/server"
import { WorkbenchShell, type WorkbenchShellProps } from "./WorkbenchShell.tsx"

export function renderWorkbenchShell(props: WorkbenchShellProps): string {
  return renderToStaticMarkup(<WorkbenchShell {...props} />)
}
