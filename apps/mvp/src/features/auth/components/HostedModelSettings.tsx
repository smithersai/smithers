import { Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "./AuthContext"

// Admin-only feature flag for the deployment's hosted inference fallback (docs/features/model-endpoint.md#hosted-inference,
// decision 0099). Off by default so the deployment launches BYOK-first; toggling takes effect on the next call with no deploy.
export function HostedModelSettings() {
  const { queries, actions } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  const enabled = session?.hostedModel === true
  const saving = session?.hostedModelSaving === true
  const failed = session?.hostedModelError === true
  return (
    <section className="hosted-model-settings" aria-label="Hosted inference">
      <h2>Hosted inference</h2>
      <p>
        {enabled
          ? "On — deployment fallback is enabled for members without their own model."
          : "Off — BYOK only. People bring their own model in Settings."}
      </p>
      <div className="hosted-model-settings-actions">
        <Button type="button" disabled={saving} onClick={() => actions.setHostedModel(!enabled)}>
          {enabled ? "Turn off (BYOK only)" : "Turn on hosted fallback"}
        </Button>
        {saving
          ? <span role="status">Saving…</span>
          : failed
            ? <span role="status">Couldn't update hosted inference.</span>
            : null}
      </div>
    </section>
  )
}
