import { PageBody } from "@smthrs/ui"
import { FileTabsBar } from "../../features/files/components/FileTabsBar"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { RepoPage } from "../../features/repo/components/RepoPage"
import "./repo-screen.css"

// /$owner/$repo/blob/$ref/$ and /$owner/$repo/raw/$ref/$: the repository at the URL's location, with its Home and Code
// tabs when it declares a home, and the strip of files open in it. The route's loader opens the location (`openRoute`) and the home; this screen only
// renders what the device has.
export function RepoScreen() {
  return (
    <main className="repo-screen" aria-label="Repository">
      <RepoHeader width="wide" />
      <PageBody width="wide">
        <HomeTabs active="code" />
        <FileTabsBar />
        <RepoPage />
      </PageBody>
    </main>
  )
}
