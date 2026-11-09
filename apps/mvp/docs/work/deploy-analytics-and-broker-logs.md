---
title: Deploy analytics permissions and broker logs
status: done
area: app
owner: maintainers
updated: 2026-11-09
links: [../infrastructure.md, ../features/sign-in.md]
---

Gate Web Analytics management with Effect Config, preserve the known WebKit beacon failure, and install structured logging in the broker's independent Durable Object request boundary. Uses the library catalog's `@smthrs/observability` entry, `Logger.layerStructuredJson`.

The resource-discovery and beacon-classification tests, browser watcher tests, and real workerd broker regressions cover the change. Deployment receipts remain private operational records.
