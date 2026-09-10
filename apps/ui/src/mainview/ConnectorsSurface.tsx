import { Alert, AlertDescription, AlertTitle, Badge, Button, Separator } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { FolderGit2, GitPullRequest, HardDrive, Plug, RefreshCw, Server, Trash2 } from "lucide-react"
import type { KeyboardEvent } from "react"
import { useController } from "./ControllerContext"
import { ConfirmDialog, SurfaceHeader } from "./SurfaceChrome"
import { ageLabel } from "./Timestamps"

const shortHead = (head: string | null): string => head?.slice(0, 8) ?? "No commits yet"

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
  const { data: connectorRows } = useLiveQuery(collections.connectors)
  const { data: operationRows } = useLiveQuery(collections.connectorOperations)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      pendingConnectorRemovalId: session.pendingConnectorRemovalId
    }))
  )
  const connectors = [...connectorRows].sort((left, right) => left.name.localeCompare(right.name))
  /*
   * Lane sync (ADR 0005): the GitHub and Linear rows read ONLY what the app
   * has actually read — the App statuses its github.app act filed and the
   * integrations the Linear seam loaded. A repo never checked is absent,
   * never assumed.
   */
  const { data: gitHubAppStatusRows } = useLiveQuery(collections.githubAppStatuses)
  const { data: linearIntegrationRows } = useLiveQuery(collections.linearIntegrations)
  const installedRepositories = gitHubAppStatusRows.filter((row) => row.installed && row.configured).length
  /* ADR 0005 "Connectors surface": Linear per team, WITH last sync — the age off the DTO's last_sync_at; nothing when it never synced. */
  const linearTeams = [...linearIntegrationRows]
    .sort((left, right) => left.teamKey.localeCompare(right.teamKey))
    .map((row) => (row.lastSyncAt !== null ? `${row.teamKey} (last sync ${ageLabel(row.lastSyncAt)})` : row.teamKey))
  const operation = operationRows.find((candidate) => candidate.id === "connector-operation") ??
    collections.connectorOperations.get("connector-operation")
  const selecting = operation?.phase === "selecting-local-repository"
  const identity = identityRows[0]
  const signedIn = identity?.state === "signed-in"
  const githubAvailable = controller.commands.find(signedIn ? "auth.sign-out" : "auth.sign-in") !== undefined
  const localAvailable = controller.nativeRepositoriesAvailable &&
    controller.commands.find("connector.add") !== undefined
  const cloudAvailable = controller.commands.find("repos.import") !== undefined
  const emptyGuidance = cloudAvailable
    ? signedIn
      ? "Import a GitHub repository into Smithers Cloud and it appears here."
      : "Connecting GitHub above is the first step; imported repositories appear here."
    : localAvailable
    ? "Choose Local repository above to connect work from this machine."
    : controller.commands.find("repo.open") !== undefined
    ? "Choose Open local repository… from the repository menu above the composer to inspect work on this machine."
    : "No repository service is available in this runtime."
  const pendingRemovalId = sessionRows[0]?.pendingConnectorRemovalId ?? null
  const pendingRemoval = connectors.find((candidate) => candidate.id === pendingRemovalId)

  interface StoreRow {
    readonly key: string
    readonly icon: "github" | "local" | "cloud" | "linear"
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
    ...(localAvailable
      ? [
        {
          key: "local",
          icon: "local",
          name: "Local repository",
          description: "A repository on this machine, read directly.",
          action: {
            kind: "button",
            label: "Connect",
            flow: "connector.add",
            args: "read",
            disabled: selecting
          }
        } satisfies StoreRow
      ]
      : []),
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
    ...(controller.commands.find("linear.connect") !== undefined ? [{
      /* Lane sync: the Linear connector — per-team state from the integrations the seam loaded. */
      key: "linear",
      icon: "linear",
      name: "Linear",
      description: linearTeams.length > 0
        ? `${linearTeams.join(", ")} connected — issues sync both ways.`
        : "Sync issues with a Linear team.",
      action: { kind: "button", label: "Connect", flow: "linear.connect" }
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
      icon === "linear" ?
      <RefreshCw size={16} aria-hidden="true" /> :
      <Server size={16} aria-hidden="true" />

  const onRowsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    /*
     * Buttons only: a status Badge also carries data-row-action (it is the
     * row's action slot) but is deliberately not a control — roving onto it
     * would call focus() on a non-focusable element and strand the ring.
     */
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(".connect-store-row button[data-row-action]")
    )
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === "ArrowDown"
      ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <section className="connectors-surface embedded-pane" aria-label="Smithers connectors">
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
                    data-flow={row.action.flow}
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

          {connectors.length === 0 ?
            (
              /*
               * §11.6: the zero case told the reader a fact and gave them no
               * move. It matters most here: on the web the one way to add a
               * repository is the import row above, and connector.add answers
               * "native app only", so a reader who is not pointed at import has
               * nowhere obvious to look. Signed out there is exactly one door
               * and it is the GitHub row (§1.1), so no second one is offered.
               */
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
                        data-flow="repos.import"
                        onClick={() => controller.runCommand("repos.import")}
                      >
                        Import a repository
                      </Button>
                    ) :
                    null}
                </div>
              </div>
            ) :
            (
              <div className="connected-repository-list">
                {connectors.map((connector) => (
                  <div className="connected-repository-card" key={connector.id}>
                    <div className="connected-repository-row">
                      <span className="connect-store-icon">
                        <FolderGit2 size={16} aria-hidden="true" />
                      </span>
                      <span className="connect-store-text">
                        <strong>{connector.name}</strong>
                        <span className="repository-path">
                          {connector.branch ?? "Detached"} · <code>{shortHead(connector.head)}</code>
                        </span>
                      </span>
                      <Badge variant={connector.access === "read-write" ? "warning" : "outline"}>
                        {connector.access === "read-write" ? "Read & write" : "Read-only"}
                      </Badge>
                      {connector.access === "read-write" ?
                        (
                          <Button
                            variant="ghost"
                            size="sm"
                            data-flow="connector.downgrade"
                            onClick={() => controller.runCommand("connector.downgrade", connector.id)}
                          >
                            Make read-only
                          </Button>
                        ) :
                        null}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${connector.name}`}
                        title={`Remove ${connector.name}`}
                        data-flow="connector.remove.ask"
                        onClick={() => controller.runCommand("connector.remove.ask", connector.id)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </section>
      </main>

      <ConfirmDialog
        open={pendingRemoval !== undefined}
        title={pendingRemoval ? `Disconnect ${pendingRemoval.name}?` : "Disconnect repository?"}
        body="Smithers will stop watching this repository. You can reconnect it any time."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => {
          if (pendingRemoval !== undefined) controller.runCommand("connector.remove", pendingRemoval.id)
        }}
        onCancel={() => controller.runCommand("connector.remove.cancel")}
      />
    </section>
  )
}
