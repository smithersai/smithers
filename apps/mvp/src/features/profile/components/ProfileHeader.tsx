import { PageHeader } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { Notices } from "../../attention/components/Notices"
import { NotificationsBell } from "../../attention/components/NotificationsBell"
import { Account } from "../../auth/components/Account"
import { ThemeButton } from "../../theme/components/ThemeButton"
import { BackToChat } from "../../views/components/BackToChat"
import { useProfile } from "./ProfileContext"

// Top bar for the owner profile screen: Back to chat, the profile's handle, theme toggle, notifications bell and account.
export function ProfileHeader() {
  const { queries } = useProfile()
  const { data } = useLiveQuery(queries.view)
  const owner = data?.entry?.profile?.login ?? data?.view.owner ?? ""
  return (
    <PageHeader
      className="profile-header"
      aria-label="Profile"
      width="wide"
      back={<BackToChat target={undefined} />}
      title={owner === "" ? "Profile" : <Link to="/$owner" params={{ owner }}>{owner}</Link>}
      actions={
        <>
          <ThemeButton />
          <NotificationsBell />
          <Account />
        </>
      }
    >
      <Notices surface="page" />
    </PageHeader>
  )
}
