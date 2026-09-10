import { fileArgs, parseFileArgs } from "../flows/FileArgs"
/*
 * The workspace card (lane citc, ADR 0002; completed by lane L3): one
 * persistent cloud computer, reviewed in the transcript.
 *
 * The header names the repository, the target bookmark, the BOOKMARK's head
 * (labeled as such), and — since plue#446 — the facts the DTO now carries:
 * the sandbox kind, the workspace's OWN head, how far ahead of and behind the
 * bookmark it is, how long it has been up, the Nix environment it was built
 * from, its persistence, the languages it relays a language server for
 * (plue#505, `lsp: typescript`), and its ssh host as a copyable line. Every one of
 * them renders only when the payload carries it: an absent field renders
 * NOTHING, never a placeholder and never a zero that was not on the wire.
 *
 * The body is five facets: the terminal and its sessions, the working copy's
 * files (the same listing component the repository file card uses, imported,
 * with the rows bound to the workspace's own routes), the declared services,
 * snapshots with their acts, and the egress audit — what this computer called
 * and which secret NAMES the proxy swapped in, never a value.
 *
 * Every act binds a registered command through onRunCommand and carries
 * data-flow (parity.test.ts gates this). The one act whose door is the
 * host's — the terminal rides the origin's `/api/cloud-ws/` tunnel, which
 * the Worker does not open until the W4 relay lands — is rendered only when
 * the live registry holds `workspace.terminal` (parity-hosts.test.ts (a‴)):
 * the pointer path drops an unregistered name silently, so a button bound to
 * it would be a dead control.
 */
import { useState, useSyncExternalStore } from "react"
import { Button, StatusPill } from "@smthrs/ui"
import { Camera, Copy, Globe, Monitor, Play, RefreshCw, Server, Square, TerminalSquare, Trash2 } from "lucide-react"
import { useController } from "../ControllerContext"
import type { Card } from "../state/AppState"
import { readDesktopStream, subscribeDesktopStream } from "../state/seams/DesktopStream"
import { DESKTOP_NOT_READY, GUEST_NOT_READY } from "../state/seams/WorkspaceSeam"
import { dayLabel, timeLabel } from "../Timestamps"
import { shortId } from "../state/ids"
import { FileListCardBody } from "./FileCards"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { flowArgs } from "../flows/FlowArgs"

export interface WorkspaceCardActions {
  readonly onRunCommand: RunCommand
}

type WorkspaceCard = Extract<Card, { kind: "workspace" }>
type WorkspacePayload = WorkspaceCard["payload"]

const FACETS = ["terminal", "files", "services", "snapshots", "egress", "desktop"] as const

/*
 * Lane L3b — ADR 0002: "three sandbox kinds share one option surface; the kind
 * is the choice." These are plue's own one-line descriptions of the three
 * kinds, in words. There is no environment or image picker beside them; that
 * is ADR 0002's standing default, not an omission.
 */
const KINDS = [
  { kind: "container", says: "legacy OCI image, the default" },
  { kind: "vm", says: "NixOS closure image, systemd PID 1" },
  { kind: "desktop", says: "NixOS closure image, systemd PID 1, plus XFCE streamed over VNC" }
] as const

/**
 * How long the computer has been up, from the DTO's `started_at`. Null when
 * the wire carried no start (the VM has never run) or when the timestamp does
 * not parse — the header then says nothing about uptime rather than guessing.
 */
export const uptimeLabel = (startedAt: string | null | undefined, now: number): string | null => {
  if (startedAt === null || startedAt === undefined || startedAt === "") return null
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return null
  const seconds = Math.floor((now - started) / 1000)
  if (seconds < 0) return null
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `up ${days}d ${hours}h`
  if (hours > 0) return `up ${hours}h ${minutes}m`
  return `up ${minutes}m`
}

/**
 * The header facts the DTO carries, in the order the brief names them. Only
 * what the payload holds: a null field contributes no entry at all, so a
 * workspace answered without a head shows no head line rather than an empty
 * one.
 */
export const headerFacts = (payload: WorkspacePayload, now: number): ReadonlyArray<string> => {
  const facts: Array<string> = []
  if (payload.workspaceKind != null && payload.workspaceKind !== "") facts.push(payload.workspaceKind)
  const head = payload.head
  if (head != null && (head.changeId != null || head.commitId != null)) {
    const ids = [head.changeId, head.commitId].filter((id): id is string => id != null && id !== "").map(shortId)
    facts.push(`workspace head @ ${ids.join(" ")}`)
  }
  if (payload.ahead != null) facts.push(`${payload.ahead} ahead`)
  if (payload.behind != null) facts.push(`${payload.behind} behind`)
  const uptime = uptimeLabel(payload.startedAt, now)
  if (uptime !== null) facts.push(uptime)
  const environment = payload.environment
  if (environment != null && environment.source !== "") {
    facts.push(
      environment.revision != null && environment.revision !== ""
        ? `${environment.source} @ ${shortId(environment.revision)}`
        : environment.source
    )
  }
  if (payload.persistence != null && payload.persistence !== "") facts.push(payload.persistence)
  /* Lane L6 (plue #505): the languages the workspace relays a language server for; an empty or absent list says nothing. */
  if (payload.lspLanguages != null && payload.lspLanguages.length > 0) facts.push(`lsp: ${payload.lspLanguages.join(", ")}`)
  return facts
}

/**
 * The TAG of a registry reference — the part after the last `:` — never the
 * whole path. A reference with no `:` at all, or one whose colon belongs to a
 * host port (`host:5000/base`), carries no tag and renders nothing.
 */
const imageTag = (image: string | null | undefined): string | null => {
  if (image === null || image === undefined || image === "") return null
  const cut = image.lastIndexOf(":")
  if (cut < 0) return null
  const tag = image.slice(cut + 1)
  return tag === "" || tag.includes("/") ? null : tag
}

/**
 * Lane L3b — the environment provenance line a vm or desktop workspace
 * carries: `env · <closure hash, first 8> · <image tag>`. A container has no
 * such line at all (it boots no closure image), and a field the DTO did not
 * answer contributes nothing — an environment that named neither renders no
 * line rather than a bare `env ·`.
 */
export const environmentProvenance = (payload: WorkspacePayload): string | null => {
  const kind = payload.workspaceKind
  if (kind !== "vm" && kind !== "desktop") return null
  const environment = payload.environment
  if (environment === null || environment === undefined) return null
  const parts: Array<string> = []
  const closure = environment.closureHash
  if (closure !== null && closure !== undefined && closure !== "") parts.push(closure.slice(0, 8))
  const tag = imageTag(environment.image)
  if (tag !== null) parts.push(tag)
  return parts.length === 0 ? null : `env · ${parts.join(" · ")}`
}

/**
 * When the minted desktop session lapses, in the app's one timestamp
 * vocabulary. A session the mint gave no expiry for says nothing — a guessed
 * deadline is worse than none, because the iframe simply dies at the real one.
 */
export const sessionUntil = (expiresAt: string | null, now: number = Date.now()): string | null => {
  if (expiresAt === null || expiresAt === "") return null
  const at = Date.parse(expiresAt)
  return Number.isNaN(at) ? null : `session until ${timeLabel(at, now)}`
}

/*
 * Lane L3b — the Desktop facet: plue's NixOS VM streamed over VNC, embedded in
 * the card (THE EMBED LAW; maximize is the card's own act, and the frame fills
 * it through cards.css).
 *
 * The iframe's `src` is the absolute, already-credentialed `stream_url` the
 * session POST minted: it embeds a live machine's token and VNC password. It
 * is therefore read from module memory (state/seams/DesktopStream.ts) through
 * `useSyncExternalStore` — React's own external-store hook, so no `useEffect`
 * and no lifecycle synchronisation — and never from the card payload, because
 * everything a payload holds is written to disk by the persistence backend.
 * Leaving the facet drops the mint, so nothing outlives the unmounted iframe.
 */
const WorkspaceDesktopBody = ({
  payload,
  onRunCommand
}: {
  readonly payload: WorkspacePayload
  readonly onRunCommand: WorkspaceCardActions["onRunCommand"]
}) => {
  const stream = useSyncExternalStore(
    subscribeDesktopStream,
    () => readDesktopStream(payload.workspaceId),
    () => null
  )
  if (stream === null) {
    const refusal = payload.desktopRefusal ?? null
    if (refusal === null) return null
    /*
     * plue's own words, verbatim — never a spinner in their place. A 409, and
     * only a 409, means the computer is not running and offers Resume. Every
     * refusal offers Retry, which runs the same mint again; a
     * `desktop_not_ready` 503 (plue#496) is ALSO retried by the seam on the
     * server's own `Retry-After`, so the button is the human's way to stop
     * waiting for that clock, not the only way forward.
     *
     * plue sanitizes a 5xx message to the status text but keeps `code`, so
     * the code is printed beside the message: without it "service
     * unavailable" would be the whole of what a person is told.
     */
    return (
      <div className="world-card-list">
        <p className="world-card-empty">
          {refusal.code != null ? `${refusal.code} — ` : ""}
          {refusal.message}
        </p>
        {refusal.code === DESKTOP_NOT_READY && refusal.retryAfterSeconds != null ?
          <p className="world-card-path">{`the server asked for ${refusal.retryAfterSeconds}s`}</p> :
          null}
        {refusal.status === 409 ?
          (
            <Button
              size="sm"
              variant="outline"
              data-flow="workspace.resume"
              aria-label="Resume the workspace and open its desktop"
              onClick={() => onRunCommand("workspace.resume", payload.workspaceId)}
            >
              <Play size={12} aria-hidden="true" /> Resume
            </Button>
          ) :
          null}
        <Button
          size="sm"
          variant="outline"
          data-flow="workspace.desktop"
          aria-label="Try the desktop session again"
          onClick={() => onRunCommand("workspace.desktop", payload.workspaceId)}
        >
          <RefreshCw size={12} aria-hidden="true" /> Retry
        </Button>
      </div>
    )
  }
  const until = sessionUntil(stream.expiresAt)
  return (
    <div className="workspace-desktop">
      <iframe
        className="workspace-desktop-frame"
        title={`Desktop of ${payload.name}`}
        src={stream.url}
        allow="clipboard-read; clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
      <p className="world-card-row">
        {until === null ? null : <span className="world-card-path">{until}</span>}
        <Button
          size="sm"
          variant="outline"
          data-flow="workspace.desktop.rotate"
          onClick={() => onRunCommand("workspace.desktop.rotate", payload.workspaceId)}
        >
          Rotate session
        </Button>
      </p>
    </div>
  )
}

/** plue's file listing carries three types; the shared listing row knows two. A symlink lists as a file. */
const listingCard = (payload: WorkspacePayload): Extract<Card, { kind: "file-list" }> => {
  const path = payload.filesPath ?? ""
  return {
    id: `workspace-files-${payload.workspaceId}`,
    kind: "file-list",
    title: `${path === "" ? "/" : path} · ${payload.name}`,
    status: "active",
    createdAt: 0,
    ordinal: 0,
    payload: {
      repo: payload.repo,
      path,
      entries: (payload.files ?? []).map((entry) => ({
        name: entry.name,
        kind: entry.type === "dir" ? ("dir" as const) : ("file" as const)
      })),
      /* The address names the computer, so the reader knows this is not the repository's copy. */
      address: `${payload.repo} · ${payload.name} · ${path === "" ? "/" : path}`
    }
  }
}

const WorkspaceFacetBody = ({
  card,
  facet,
  canTerminal,
  onRunCommand
}: {
  readonly card: WorkspaceCard
  readonly facet: (typeof FACETS)[number]
  /** Whether this host registers `workspace.terminal` (its tunnel is open); false renders the fact, not a button. */
  readonly canTerminal: boolean
  readonly onRunCommand: WorkspaceCardActions["onRunCommand"]
}) => {
  const { payload } = card
  if (facet === "desktop") return <WorkspaceDesktopBody payload={payload} onRunCommand={onRunCommand} />
  if (facet === "files") {
    if (payload.files === undefined) return null
    /*
     * The repository file card's listing, imported rather than copied. Its
     * rows dispatch files.list / files.read; here the same click reads the
     * WORKSPACE's copy, so the binding is retargeted to the workspace routes
     * with the workspace id appended.
     */
    return (
      <FileListCardBody
        card={listingCard(payload)}
        onRunCommand={(name, args) => {
          const parsed = parseFileArgs(args)
          if ("error" in parsed) return
          onRunCommand(
            name === "files.list" ? "workspace.files" : "workspace.file",
            fileArgs(parsed.tokens[0] ?? "", payload.workspaceId)
          )
        }}
      />
    )
  }
  if (facet === "services") {
    if (payload.services === undefined) return null
    return (
      <ul className="world-card-list">
        {payload.services.length === 0 ?
          <li className="world-card-empty">{payload.name} declares no services.</li> :
          payload.services.map((service) => (
            <li key={service.name} className="world-card-row">
              <Server size={14} aria-hidden="true" />
              <span className="world-card-title">{service.name}</span>
              <StatusPill status={service.state} />
              {/* plue#483: the port and the url the service publishes; a service that publishes neither shows neither. */}
              {service.port != null ? <span className="world-card-path">{`port ${service.port}`}</span> : null}
              {service.url != null ? <span className="world-card-path">{service.url}</span> : null}
            </li>
          ))}
      </ul>
    )
  }
  if (facet === "egress") {
    if (payload.egress === undefined) return null
    return (
      <div className="world-card-list">
        <ul className="world-card-list">
          {payload.egress.length === 0 ?
            <li className="world-card-empty">{payload.name} made no recorded calls.</li> :
            payload.egress.map((row, index) => (
              <li key={`${row.occurredAt}-${index}`} className="world-card-row">
                <Globe size={14} aria-hidden="true" />
                <span className="world-card-path">{row.occurredAt}</span>
                <span className="world-card-title">{row.method} {row.host}{row.path}</span>
                <span className="world-card-path">{row.status}</span>
                <span className="world-card-path">{row.allowed ? "allowed" : "blocked"}</span>
                {/* Which binding the proxy substituted — the NAME, never the value. */}
                {row.swappedSecretNames.length === 0 ?
                  null :
                  <span className="world-card-path">secrets {row.swappedSecretNames.join(", ")}</span>}
              </li>
            ))}
        </ul>
        {payload.egressCursor != null && payload.egressCursor !== "" ?
          (
            <Button
              size="sm"
              variant="outline"
              data-flow="workspace.egress"
              onClick={() => onRunCommand("workspace.egress", `${payload.workspaceId} ${payload.egressCursor ?? ""}`)}
            >
              Load older
            </Button>
          ) :
          null}
      </div>
    )
  }
  if (facet === "snapshots") {
    return (
      <ul className="world-card-list">
        {payload.snapshots.length === 0 ?
          <li className="world-card-empty">No snapshots of {payload.name} yet.</li> :
          payload.snapshots.map((snapshot) => (
            <li key={snapshot.id} className="world-card-row">
              <Camera size={14} aria-hidden="true" />
              <span className="world-card-title">{snapshot.name}</span>
              {snapshot.createdAt !== null ?
                <span className="world-card-path">{dayLabel(snapshot.createdAt)}</span> :
                null}
              <Button
                size="sm"
                variant="outline"
                data-flow="workspace.snapshot.fork"
                aria-label={`Fork a workspace from ${snapshot.name}`}
                onClick={() => onRunCommand("workspace.snapshot.fork", `${snapshot.id} ${payload.workspaceId}`)}
              >
                Fork from
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-flow="workspace.template"
                aria-label={`Create a template from ${snapshot.name}`}
                onClick={() =>
                  onRunCommand(
                    "workspace.template",
                    flowArgs("workspace.template", { snapshotId: snapshot.id, workspaceId: payload.workspaceId, name: snapshot.name })
                  )}
              >
                Make template
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-flow="workspace.snapshot.delete"
                aria-label={`Delete snapshot ${snapshot.name}`}
                onClick={() => onRunCommand("workspace.snapshot.delete", `${snapshot.id} ${payload.workspaceId}`)}
              >
                <Trash2 size={12} aria-hidden="true" /> Delete
              </Button>
            </li>
          ))}
      </ul>
    )
  }
  /* The terminal facet: the attachment, then every session the workspace holds. */
  const terminalRefusal = payload.terminalRefusal ?? null
  return (
    <div className="world-card-list">
      {payload.terminalSessionId !== undefined ?
        (
          <p className="world-card-row">
            <TerminalSquare size={14} aria-hidden="true" />
            <span className="world-card-title">Attached to session {payload.terminalSessionId}</span>
          </p>
        ) :
        <p className="world-card-empty">No terminal attached.</p>}
      {/*
       * plue's own words for a refused session POST, verbatim (plue#504).
       * plue sanitizes a 5xx message to the status text but keeps `code`, so
       * the code is printed beside it: without it "service unavailable" would
       * be the whole of what a person is told. A `guest_not_ready` 503 is ALSO
       * retried by the seam on the server's own `Retry-After`, so the button
       * is the human's way to stop waiting for that clock, not the only way
       * forward.
       */}
      {terminalRefusal !== null ?
        (
          <>
            <p className="world-card-empty">
              {terminalRefusal.code != null ? `${terminalRefusal.code} — ` : ""}
              {terminalRefusal.message}
            </p>
            {terminalRefusal.code === GUEST_NOT_READY && terminalRefusal.retryAfterSeconds != null ?
              <p className="world-card-path">{`the server asked for ${terminalRefusal.retryAfterSeconds}s`}</p> :
              null}
          </>
        ) :
        null}
      {canTerminal ?
        (
          <Button
            size="sm"
            data-flow="workspace.terminal"
            {...(terminalRefusal === null ? {} : { variant: "outline" as const, "aria-label": "Try the terminal again" })}
            onClick={() => onRunCommand("workspace.terminal", payload.workspaceId)}
          >
            {terminalRefusal === null ? "Open terminal" : <><RefreshCw size={12} aria-hidden="true" /> Retry</>}
          </Button>
        ) :
        <p className="world-card-empty">Terminals are not on the web yet.</p>}
      {payload.sessions.length === 0 ?
        null :
        (
          <ul className="world-card-list">
            {payload.sessions.map((session) => (
              <li key={session.id} className="world-card-row">
                <Monitor size={14} aria-hidden="true" />
                <span className="world-card-title">{session.id}</span>
                <StatusPill status={session.status} />
                <Button
                  size="sm"
                  variant="outline"
                  data-flow="workspace.session.destroy"
                  aria-label={`Destroy session ${session.id}`}
                  onClick={() => onRunCommand("workspace.session.destroy", `${session.id} ${payload.workspaceId}`)}
                >
                  Destroy
                </Button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

export const WorkspaceCardBody = ({
  card,
  onRunCommand
}: { readonly card: WorkspaceCard } & WorkspaceCardActions) => {
  const { payload } = card
  const facet = payload.facet ?? "terminal"
  /* The registry is the truth about the terminal door: the Worker registers workspace.terminal only once its relay is on. */
  const canTerminal = useController().commands.find("workspace.terminal") !== undefined
  /* The delete act's typed confirm: the draft is transient chrome state, never a store fact. */
  const [deleteDraft, setDeleteDraft] = useState<string | null>(null)
  /* Uptime is derived at render from the payload's start time — no lifecycle, no timer, no stored duration. */
  const facts = headerFacts(payload, Date.now())
  const provenance = environmentProvenance(payload)
  const sshHost = payload.sshHost ?? null
  return (
    <div className="world-card-list">
      <p className="world-card-row">
        <span className="world-card-path">
          {payload.repo}
          {payload.targetBookmark !== null ? ` · ${payload.targetBookmark}` : ""}
          {payload.bookmarkHead?.changeId != null ?
            ` · bookmark ${payload.targetBookmark ?? ""} head @ ${payload.bookmarkHead.changeId.slice(0, 8)}` :
            ""}
        </span>
        <StatusPill status={payload.status} />
      </p>
      {facts.length === 0 ? null : <p className="world-card-path">{facts.join(" · ")}</p>}
      {/* Lane L3b: what a vm or desktop workspace actually booted — the closure short and the image TAG. */}
      {provenance === null ? null : <p className="world-card-path">{provenance}</p>}
      {/*
        RFD-004: the agent session that drove this computer. It is stated, not
        opened: this app has no agent-session surface, and binding "Open the
        agent session" to a flow that means something else would mislabel it.
      */}
      {payload.agentSessionId === null || payload.agentSessionId === undefined || payload.agentSessionId === "" ?
        null :
        <p className="world-card-path">agent session {payload.agentSessionId}</p>}
      {sshHost === null || sshHost === "" ?
        null :
        (
          <p className="world-card-row">
            <span className="world-card-path">{sshHost}</span>
            <Button
              size="sm"
              variant="ghost"
              data-flow="chat.copy-message"
              aria-label={`Copy ${sshHost}`}
              onClick={() => onRunCommand("chat.copy-message", sshHost)}
            >
              <Copy size={12} aria-hidden="true" /> Copy
            </Button>
          </p>
        )}
      {payload.provisioningStage !== null && (payload.status === "pending" || payload.status === "starting") ?
        <p className="world-card-path">Provisioning: {payload.provisioningStage}</p> :
        null}
      {payload.suspendedAt != null && payload.status === "suspended" ?
        <p className="world-card-path">Suspended {dayLabel(payload.suspendedAt)}</p> :
        null}
      {/*
        plue's own contract code for a worker that could not start the
        per-sandbox egress proxy and refused to boot the computer without its
        credential boundary. The card says the code, exactly.
      */}
      {payload.egressProxyUnavailable === true ? <p className="world-card-empty">egress_proxy_unavailable</p> : null}
      {/*
        plue#482: why a failed computer failed, in the provider's own words.
        The code is a machine verdict and survives plue's 5xx message
        sanitizer, so both are shown and neither is paraphrased.
      */}
      {payload.failureCode != null || payload.failureMessage != null ?
        (
          <p className="world-card-empty">
            {payload.failureCode ?? ""}
            {payload.failureCode != null && payload.failureMessage != null ? " — " : ""}
            {payload.failureMessage ?? ""}
          </p>
        ) :
        null}
      {payload.error !== undefined ? <p className="world-card-empty">{payload.error}</p> : null}
      {/*
        The card's create affordance (ADR 0002): one option surface, three
        kinds, each in plue's own words. The kind rides the invocation so it
        reaches the POST body; there is no environment or image picker.
      */}
      {payload.status === "failed" ?
        (
          <p className="world-card-row">
            {payload.provisioningStage !== null ?
              <span className="world-card-path">Failed at {payload.provisioningStage}.</span> :
              null}
            {KINDS.map(({ kind, says }) => (
              <Button
                key={kind}
                size="sm"
                variant="outline"
                data-flow="workspace.open"
                aria-label={`Open a ${kind} workspace`}
                onClick={() =>
                  onRunCommand(
                    "workspace.open",
                    `${
                      payload.targetBookmark === null ? payload.repo : `${payload.targetBookmark} ${payload.repo}`
                    } --kind ${kind}`
                  )}
              >
                {kind} — {says}
              </Button>
            ))}
          </p>
        ) :
        null}
      {/*
        Lane L3b: the Desktop tab exists only for a desktop workspace — a
        container and a vm have no display to stream. Opening it runs
        `workspace.desktop`, which MINTS a session (a live machine's password),
        so it is its own confirmed act rather than a facet switch.
      */}
      <div className="world-card-row" role="tablist" aria-label="Workspace facets">
        {FACETS.filter((name) => name !== "desktop" || payload.workspaceKind === "desktop").map((name) => (
          <Button
            key={name}
            size="sm"
            variant={name === facet ? "default" : "outline"}
            role="tab"
            aria-selected={name === facet}
            data-flow={name === "desktop" ? "workspace.desktop" : "workspace.facet"}
            onClick={() =>
              name === "desktop"
                ? onRunCommand("workspace.desktop", payload.workspaceId)
                : onRunCommand("workspace.facet", `${payload.workspaceId} ${name}`)}
          >
            {name[0]!.toUpperCase()}{name.slice(1)}
          </Button>
        ))}
      </div>
      <WorkspaceFacetBody card={card} facet={facet} canTerminal={canTerminal} onRunCommand={onRunCommand} />
      <div className="world-card-row">
        {payload.status === "running" ?
          (
            <Button
              size="sm"
              variant="outline"
              data-flow="workspace.suspend"
              onClick={() => onRunCommand("workspace.suspend", payload.workspaceId)}
            >
              <Square size={12} aria-hidden="true" /> Suspend
            </Button>
          ) :
          null}
        {payload.status === "suspended" || payload.status === "stopped" ?
          (
            <Button
              size="sm"
              variant="outline"
              data-flow="workspace.resume"
              onClick={() => onRunCommand("workspace.resume", payload.workspaceId)}
            >
              <Play size={12} aria-hidden="true" /> Resume
            </Button>
          ) :
          null}
        <Button
          size="sm"
          variant="outline"
          data-flow="workspace.fork"
          onClick={() => onRunCommand("workspace.fork", `${payload.workspaceId} ${payload.name}-fork`)}
        >
          <Copy size={12} aria-hidden="true" /> Fork
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-flow="workspace.snapshot"
          onClick={() => onRunCommand("workspace.snapshot", payload.workspaceId)}
        >
          <Camera size={12} aria-hidden="true" /> Snapshot
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-flow="workspace.delete"
          onClick={() => setDeleteDraft((draft) => (draft === null ? "" : null))}
        >
          <Trash2 size={12} aria-hidden="true" /> Delete
        </Button>
      </div>
      {deleteDraft !== null ?
        (
          <p className="world-card-row">
            <span className="world-card-path">
              Type {payload.name} to delete {payload.workspaceId} permanently:
            </span>
            <input
              aria-label={`Type ${payload.name} to confirm the delete`}
              value={deleteDraft}
              onInput={(event) => setDeleteDraft(event.currentTarget.value)}
            />
            <Button
              size="sm"
              variant="outline"
              data-flow="workspace.delete"
              disabled={deleteDraft !== payload.name}
              onClick={() => onRunCommand("workspace.delete", `${payload.workspaceId} ${deleteDraft}`)}
            >
              Delete permanently
            </Button>
          </p>
        ) :
        null}
    </div>
  )
}

/*
 * Lane L3b — the environment images a repository has built (ADR 0002: the
 * environment is stated, never chosen, so this card lists and offers nothing
 * to press). Each row is what plue answered: the sandbox kind the closure
 * boots, the closure's first eight, the image TAG, and the status. plue's
 * `repository_id 0` reads as the platform base image; an image with no golden
 * snapshot says its first boot pays the registry pull, which is the only
 * reason a reader would care.
 */
export const EnvironmentImagesCardBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "environment-images" }>
}) => {
  const { repo, images } = card.payload
  return (
    <ul className="world-card-list">
      {images.length === 0 ?
        <li className="world-card-empty">{repo} has built no environment images.</li> :
        images.map((image) => (
          <li key={image.id} className="world-card-row">
            <Server size={14} aria-hidden="true" />
            <span className="world-card-title">{image.kind}</span>
            {image.closureHash === null ? null : <span className="world-card-path">{image.closureHash.slice(0, 8)}</span>}
            {imageTag(image.image) === null ? null : <span className="world-card-path">{imageTag(image.image)}</span>}
            <StatusPill status={image.status} />
            {image.platformBase ? <span className="world-card-path">platform base</span> : null}
            {image.coldPull ? <span className="world-card-path">first boot is a cold pull</span> : null}
          </li>
        ))}
    </ul>
  )
}

export const workspaceCardFamily: CardFamily<"workspace" | "environment-images"> = {
  /* Lane citc: the workspace's own status is the pill. */
  workspace: {
    render: (card, actions) => <WorkspaceCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => card.payload.status
  },
  /* The catalogue is a read: the seam upserts it once, already settled, so it never waits on an act. */
  "environment-images": { render: (card) => <EnvironmentImagesCardBody card={card} />, pill: settledPill }
}
