import { PageBody } from "@smthrs/ui"
import { HomePage } from "../../features/home/components/HomePage"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { RepoPage } from "../../features/repo/components/RepoPage"
import "./repo-screen.css"

// /$owner/$repo: the repository's own home when it declares one (decision 0014 §4), with Code one tab away; else its
// file tree, as on any repository. The route's loader opens the location and the home; this screen only renders what
// the device has.
export function RepoHomeScreen() {
  return (
    <main className="repo-screen" aria-label="Repository">
      <RepoHeader />
      <PageBody width="wide">
        <HomeTabs active="home" />
        <HomePage tree={<RepoPage />} />
      </PageBody>
    </main>
  )
}
