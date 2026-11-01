import { PageBody } from "@smthrs/ui"
import { DocsPage } from "../../features/docs/components/DocsPage"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import "../repo/repo-screen.css"
import "./docs-screen.css"

// /$owner/$repo/docs and /$owner/$repo/docs/<page>: the repository's docs, under its header and tabs. The routes open
// the docs, the repository and its home; this screen only renders what the tab has.
export function DocsScreen() {
  return (
    <main className="repo-screen" aria-label="Repository">
      <RepoHeader width="default" />
      <PageBody width="default">
        <HomeTabs active="docs" />
        <DocsPage />
      </PageBody>
    </main>
  )
}
