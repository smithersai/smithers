import { Input, SmithersUiStyles } from "@smthrs/ui"
import { createRoot } from "react-dom/client"
import { IssueSort } from "../../src/features/issues/components/IssueSort"

createRoot(document.getElementById("app")!).render(<>
  <SmithersUiStyles withTheme />
  <main className="issues-screen"><div className="list-search-tools">
    <Input aria-label="Search issues" />
    <IssueSort value="updated" onChange={value => { document.documentElement.dataset.sort = value }} />
  </div></main>
</>)
