import { useLiveQuery } from "@tanstack/react-db"
import type { StorageRecoveryAction } from "./state/StorageRecoveryAction"
import { RECOVERY_DOWNLOAD_LABEL, STORAGE_RECOVERY_EXPORT } from "./state/StorageRecoveryContract"

/** Only operation status is projected; the recovery file never enters React. */
export function StorageRecoveryButton({ state, onDownload }: {
  readonly state: StorageRecoveryAction["state"]
  readonly onDownload: () => void
}) {
  const { data } = useLiveQuery((query) => query.from({ recovery: state }), [state])
  const row = data[0]
  return (
    <span>
      <button
        type="button"
        className="message-cta"
        data-flow={STORAGE_RECOVERY_EXPORT}
        disabled={row?.phase === "preparing"}
        onClick={onDownload}
      >
        {row?.phase === "preparing" ? "Preparing recovery file…" : RECOVERY_DOWNLOAD_LABEL}
      </button>
      <span role="status" aria-live="polite">{row?.message}</span>
    </span>
  )
}
