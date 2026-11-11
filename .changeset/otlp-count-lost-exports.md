---
"@smthrs/observability": patch
---

`Otlp.layer` and `Otlp.layerFetch` count an export the exporter gives up. A batch the collector refused (a 401 or 404
at once, a 408, 429, 500, 502, 503 or 504 after three retries), a batch whose transport failed after three retries, and a batch whose
`transform` throws now increment `flows_observability_otlp_dropped` and log the `otlp_export_discarded` warning with
reason `refused` (and the collector's `status`), `failed`, or `transform`. Before, these batches were lost with the
counter at 0 and only a `Debug` record.
