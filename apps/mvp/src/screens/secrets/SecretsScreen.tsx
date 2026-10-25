import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { useParams } from "@tanstack/react-router"
import { SecretsPage } from "../../features/secrets/components/SecretsPage"
import { SECRETS } from "../../features/secrets/copy"
import "./secrets-screen.css"

// /$owner/$repo/settings/secrets: the repository's secrets by name, which an Admin adds, rotates and deletes
// (docs/features/secrets.md#the-secrets-page). The route's `beforeLoad` opens the repository's list; this screen only
// renders what the device has.
export function SecretsScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/settings/secrets" })
  return (
    <main className="secrets-screen" aria-label={SECRETS}><RepoHeader /><HomeTabs />
      <SecretsPage owner={owner} repo={repo} />
    </main>
  )
}
