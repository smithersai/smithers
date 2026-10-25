# 0106: Production log captures need a receipt and integrity checks

Date: 2026-10-25

Status: Accepted

The production sweep observed browser usage lines but no matching relayed records, and a stored question without its server question record. The record and field allowlists include the required usage data; the question handler logs before returning its response. Those observations do not establish missing instrumentation.

Use the library catalog's `@smthrs/flow` RunMetrics and `@smthrs/observability` OTLP exporter and relay without a second telemetry implementation. Verify flow usage through the real engine, exporter and relay in the integration suite.

Usage and ask correlation captures select POST invocations carrying an opaque per-capture header, excluding unrelated traffic before streaming. Install the header before the page and its engine worker start. The selector covers asks, answer writes and all three telemetry signals. A production E2E opens its log tail only after receiving the exact trace of a content-free refused ask. Unrelated traffic cannot release readiness. Fail explicitly when readiness times out, the socket disconnects, or Cloudflare reports sampling. Resuming streaming does not repair a gap. A later capture can open a new tail. Preserve every existing usage and correlation assertion.

The probe is signed out, sends only `{}`, starts no flow or model and stores no question. Retain only safe protocol types; never emit content, credentials, request metadata or provider error text.

This repairs the capture protocol and readiness contract, not the remaining production gap. A fully acknowledged browser transport reproduction still loses records without an overload notification. Preserve that reproduction as a deployment known failure and compare stored logs before declaring the original failures resolved.
