# Grafana dashboards

Dashboards as code for a self-hosted Grafana with Loki, such as the `grafana/otel-lgtm` stack. No secrets live here.

| File | What it is |
|---|---|
| `flow-usage.json` | **Smithers: flow usage**: which flows run, and how ([observability](../../docs/observability.md#flow-usage)) |
| `provisioning/dashboards.yaml` | The provider that loads every dashboard in `/var/lib/grafana/dashboards/smithers` into the folder Smithers |

## Flow usage

Panels, over the dashboard's time range:

| Panel | Reads |
|---|---|
| Top flows by runs | `flow.run.started`, counted by `flow` |
| Success rate by flow | `flow.run.settled` with `outcome` `succeeded`, over every `flow.run.settled` |
| Duration p50 and p95 by flow | `flow.run.settled` `durationMs` |
| Doors, Placements | `flow.run.started` by `door` and by `placement` |
| Failures by code | `flow.run.settled` other than `succeeded`, by `flow`, `outcome` and `code` |
| Model tokens by flow | `flow.model.call` `inputTokens` and `outputTokens` |
| Metered tokens and spend by role | `model.spend` `tokens` and `costUsd`; on the app a flow's model is its role |

The engine writes those lines for every run (`@smthrs/flow` `RunMetrics`): the browser engine's reach ChatApi's log through `/api/telemetry`, and the Cloudflare executions' are their own Workers log lines. The dashboard reads them from Loki, one JSON object per line (`{"message": …, "annotations": {…}}`, `Logger.layerStructuredJson`), with LogQL's `json` parser. Logs, not Prometheus series: a browser's counters start over on every reload, so a count per line is what adds up across devices.

Two variables:

- `datasource`: the Loki data source.
- `stream`: the stream selector that holds the Workers' lines. The default, `{service_name=~".+"}`, reads every stream; narrow it to the label your ingest gives the Workers, such as `{service_name="smithers-mvp-chat"}`.

## Load it

Provisioning, so the dashboard is code and the UI can't drift from it:

1. Copy `flow-usage.json` to the server, into the directory the provider reads: `/var/lib/grafana/dashboards/smithers/`.
2. Copy `provisioning/dashboards.yaml` into Grafana's `conf/provisioning/dashboards/`. In `grafana/otel-lgtm` that is `/otel-lgtm/grafana/conf/provisioning/dashboards/`; mount both paths into the container:

   ```sh
   docker run … \
     -v "$PWD/flow-usage.json:/var/lib/grafana/dashboards/smithers/flow-usage.json:ro" \
     -v "$PWD/provisioning/dashboards.yaml:/otel-lgtm/grafana/conf/provisioning/dashboards/smithers.yaml:ro" \
     grafana/otel-lgtm
   ```

3. Restart Grafana once to read the provider. Later edits to the JSON load within a minute.

Getting production's logs into that Loki is the ingest path's job, set up and documented with the server, not here.

## Tests

`ops/grafana/dashboard.test.ts` fails when a panel reads a log line or a field the app's telemetry contract (`src/flows/contract.ts`) doesn't relay, or the model endpoint doesn't write.

