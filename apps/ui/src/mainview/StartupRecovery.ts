import { createRecoveryDownload } from "./state/BrowserStorageRecovery"
import { createStorageRecoveryAction } from "./state/StorageRecoveryAction"
import type { StorageRecoveryHost } from "./state/StorageRecoveryAction"
import {
  RECOVERY_DOWNLOAD_LABEL,
  RECOVERY_PRIVATE_WARNING,
  STORAGE_RECOVERY_EXPORT
} from "./state/StorageRecoveryContract"

/** A non-React projection: the watchdog must also work when React never boots. */
export const createStartupRecovery = (
  documentTarget: Document,
  host?: StorageRecoveryHost,
  loadFlow: () => Promise<typeof import("./flows/StorageRecoveryFlow")> = () => import("./flows/StorageRecoveryFlow")
) => {
  let download: ReturnType<typeof createRecoveryDownload> | undefined
  const action = createStorageRecoveryAction(
    host ?? {
      read: async () => (await import("./state/AppStore")).readUnopenedBrowserRecovery(),
      download: (json) => (download ??= createRecoveryDownload(documentTarget)).download(json)
    },
    "user"
  )
  const element = documentTarget.createElement("section")
  const warning = documentTarget.createElement("p")
  warning.textContent = RECOVERY_PRIVATE_WARNING
  const button = documentTarget.createElement("button")
  button.type = "button"
  button.dataset.flow = STORAGE_RECOVERY_EXPORT
  const status = documentTarget.createElement("p")
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  const render = (): void => {
    const row = action.state.get("recovery")
    button.disabled = row?.phase === "preparing"
    button.textContent = row?.phase === "preparing" ? "Preparing recovery file…" : RECOVERY_DOWNLOAD_LABEL
    status.textContent = row?.message ?? ""
  }
  const subscription = action.state.subscribeChanges(render)
  render()
  button.onclick = () => {
    // The startup shell must not initialize the engine before the app's async
    // boot boundary. Load the binding only when the human takes this action.
    void loadFlow().then(({ invokeStartupRecovery, storageRecoveryExportFlow }) =>
      invokeStartupRecovery(storageRecoveryExportFlow(action.run))
    ).catch(async () => {
      // The Flow normally returns a structured failure. An engine defect must
      // not turn raw host errors into browser error telemetry either.
      try {
        await action.bindingUnavailable()
      } catch {
        console.warn("Smithers: the local recovery action could not finish. Reload before retrying.")
      }
    })
  }
  element.append(warning, button, status)
  let closing: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (closing !== undefined) return closing
    button.onclick = null
    button.disabled = true
    subscription.unsubscribe()
    closing = action.dispose().finally(() => download?.dispose())
    return closing
  }
  return { element, dispose }
}

/** React's commit-time ref owns the same DOM projection; no render-time resources or useEffect. */
export const mountStartupRecovery = (host: HTMLDivElement | null): (() => void) | undefined => {
  if (host === null) return undefined
  const recovery = createStartupRecovery(host.ownerDocument)
  host.append(recovery.element)
  return () => {
    recovery.element.remove()
    void recovery.dispose().catch(() => {
      console.warn("Smithers: local recovery cleanup could not finish. Reload before retrying.")
    })
  }
}
