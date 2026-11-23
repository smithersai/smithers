import { PageBody } from "@smthrs/ui"
import { ProfileHeader } from "../../features/profile/components/ProfileHeader"
import { ProfilePage } from "../../features/profile/components/ProfilePage"
import "./profile-screen.css"

// `/$owner`: GitHub-style user or organization profile screen.
export function ProfileScreen() {
  return (
    <main id="main-content" className="profile-screen" aria-label="Profile">
      <ProfileHeader />
      <PageBody width="wide">
        <ProfilePage />
      </PageBody>
    </main>
  )
}
