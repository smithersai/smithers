import { dynamicFlowProps, flowAction } from "./flows/FlowAction"
import { Alert, AlertDescription, AlertTitle, Badge, Button, Separator } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { FolderGit2, GitPullRequest, HardDrive, Plug, Server } from "lucide-react"
import type { KeyboardEvent } from "react"
import { useController } from "./ControllerContext"
import { rovingKeyDown } from "./RovingKeyDown"
import { SurfaceHeader } from "./SurfaceChrome"

/*
 * The connect surface (Wave 10, §2e): extension-store grammar — a compact
 * list of connector rows: icon, name, ONE line of description, one action
 * (Connect / Connected ✓ / Coming soon). No paragraphs, no prose blocks.
 * Keyboard-complete: arrows move between rows, Enter is the row's action.
 * Sign-in IS the GitHub connector (§2a′): a valid session reads Connected.
 */
export function ConnectorsSurface() {
  const controller = useController()
  const { collections } = controller.store
  const { data: operationRows } = useLiveQuery(collections.connectorOperations)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)

  const { data: gitHubAppStatusRows } = useLiveQuery(collections.githubAppStatuses)
  const installedRepositories = gitHubAppStatusRows.filter((row) => row.installed && row.configured).length
  const operation = operationRows.find((candidate) => candidate.id === "connector-operation") ??
    collections.connectorOperations.get("connector-operation")
  const selecting = operation?.phase === "selecting-local-repository"
  const identity = identityRows[0]
  const signedIn = identity?.state === "signed-in"
  const githubAvailable = controller.commands.find(signedIn ? "auth.sign-out" : "auth.sign-in") !== undefined
  const cloudAvailable = controller.commands.find("repos.import") !== undefined
  const emptyGuidance = cloudAvailable
    ? signedIn
      ? "Import a GitHub repository into Smithers Cloud and it appears here."
      : "Connecting GitHub above is the first step; imported repositories appear here."
    : "No repository service is available in this runtime."

  interface StoreRow {
    readonly key: string
    readonly icon: "github" | "local" | "cloud"
    readonly name: string
    readonly description: string
    readonly action:
      | {
        readonly kind: "button"
        readonly label: string
        readonly flow: string
        readonly args?: string
        readonly disabled?: boolean
      }
      | { readonly kind: "badge"; readonly label: string; readonly variant: "success" | "outline" }
  }

  const rows: ReadonlyArray<StoreRow> = [
    ...(githubAvailable ? [{
      /*
       * Lane sync: signed in, the row's act is github.app — the App status
       * read that renders the connector-setup card. Signed out, sign-in IS
       * still the GitHub connector (§2a′). The count is only what the app
       * has read — a repository never checked is not claimed.
       */
      key: "github",
      icon: "github",
      name: "GitHub",
      description: installedRepositories > 0
        ? `App installed on ${installedRepositories} ${installedRepositories === 1 ? "repository" : "repositories"} — issues, pull requests, and reviews.`
        : "Issues, pull requests, and reviews from the repositories you choose.",
      action: signedIn
        ? { kind: "button", label: "Check the App", flow: "github.app" }
        : { kind: "button", label: "Connect", flow: "auth.sign-in" }
    } satisfies StoreRow] : []),
    ...(cloudAvailable ? [{
      /*
       * repos.import mirrors a GitHub repository into Smithers Cloud and is
       * tracked by the repo-import card.
       *
       * §1.1: importing needs a session, and pressing it signed out only
       * defers into the GitHub row above. Offering it as available work
       * made the signed-out app look like it had several ways in when it
       * has one; signed out it states what it needs instead.
       */
      key: "cloud",
      icon: "cloud",
      name: "Smithers Cloud repository",
      description: "Import a GitHub repository into hosted workspace storage.",
      action: signedIn
        ? { kind: "button", label: "Import", flow: "repos.import" }
        : { kind: "badge", label: "Needs GitHub", variant: "outline" }
    } satisfies StoreRow] : [])
  ]

  const rowIcon = (icon: StoreRow["icon"]) =>
    icon === "github" ?
      <GitPullRequest size={16} aria-hidden="true" /> :
      icon === "local" ?
      <HardDrive size={16} aria-hidden="true" /> :
      <Server size={16} aria-hidden="true" />

  const onRowsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    /*
     * Buttons only: a status Badge also carries data-row-action (it is the
     * row's action slot) but is deliberately not a control — roving onto it
     * would call focus() on a non-focusable element and strand the ring.
     */
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(".connect-store-row button[data-row-action]")
    )
    const move = rovingKeyDown(event.key, {
      count: items.length,
      current: items.indexOf(document.activeElement as HTMLElement)
    })
    if (move.kind !== "move") return
    event.preventDefault()
    items[move.index]?.focus()
  }

  return (
    <section data-keyboard-pane="Connectors" className="connectors-surface embedded-pane" aria-label="Smithers connectors">
      <SurfaceHeader
        icon={<Plug size={17} />}
        title="Connectors"
        subtitle="What Smithers can see and change"
        closeCommand="chat"
        onClose={() => controller.runCommand("chat")}
      />

      <main className="connectors-content">
        {operation?.error ?
          (
            <Alert variant="destructive">
              <AlertTitle>Repository not connected</AlertTitle>
              <AlertDescription>{operation.error}</AlertDescription>
            </Alert>
          ) :
          null}

        <div className="connect-store-list" role="list" aria-label="Connectors" onKeyDown={onRowsKeyDown}>
          {rows.map((row) => (
            <div className="connect-store-row" role="listitem" key={row.key}>
              <span className="connect-store-icon">{rowIcon(row.icon)}</span>
              <span className="connect-store-text">
                <strong>{row.name}</strong>
                <span>{row.description}</span>
              </span>
              {row.action.kind === "button" ?
                (
                  <Button
                    size="sm"
                    variant="outline"
                    {...dynamicFlowProps(row.action.flow)}
                    data-row-action
                    disabled={row.action.disabled === true}
                    loading={row.action.flow === "connector.add" && selecting}
                    onClick={() =>
                      row.action.kind === "button"
                        ? controller.runCommand(row.action.flow, row.action.args)
                        : undefined}
                  >
                    {row.action.label}
                  </Button>
                ) :
                (
                  /*
                   * §21.2: a status badge is not interactive. Giving it a tab
                   * stop put a control in the ring that does nothing when
                   * activated, so a keyboard user pays a keystroke for it and
                   * gets no act back.
                   */
                  <Badge variant={row.action.variant} data-row-action>
                    {row.action.label}
                  </Badge>
                )}
            </div>
          ))}
        </div>

        <Separator />

        <section className="connected-repositories" aria-labelledby="connected-repositories-title">
          <div className="connected-repositories-heading">
            <div>
              <h2 id="connected-repositories-title">Connected repositories</h2>
            </div>
          </div>

          {/*
           * §11.6: the zero case told the reader a fact and gave them no
           * move. Since the local backend retired there is one door, import,
           * and signed out there is exactly one before it, the GitHub row.
           */}
          <div className="connector-empty">
            <FolderGit2 size={20} />
            <div>
              <strong>No repositories connected</strong>
              <span>{emptyGuidance}</span>
              {signedIn && cloudAvailable ?
                (
                  <Button
                    size="sm"
                    variant="outline"
                    {...flowAction(controller.runCommand, "repos.import")}
                  >
                    Import a repository
                  </Button>
                ) :
                null}
            </div>
          </div>
        </section>
      </main>

    </section>
  )
}
