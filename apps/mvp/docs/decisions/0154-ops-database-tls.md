# 0154 — Verify ops database TLS

2026-11-02. Will requested verified TLS for standalone operations, including feed-barrier confirmation, role expiry and runner cutover.

Every `DATABASE_URL` consumer under `ops/` uses `ops/database/Connection.ts` before deployment lookups or opening a database connection. Remote authorities require `sslmode=verify-full`, or `sslmode=require&sslrootcert=<CA file>`. Literal IPv4 loopback, IPv6 `::1`, and localhost remain available without TLS. Endpoint overrides and duplicate TLS parameters are refused. Validation failures name only the authority hostname; malformed URLs receive a fixed message, with no URL parser cause.

Keep the existing `db/Database.layer` over Effect SQL `PgClient`; its optional SSL configuration lets this boundary supply explicit TLS options without another driver. The native `@effect/sql-pg` 4.0.5 driver ignores `sslrootcert`, so the operations boundary reads and validates that CA file itself. It sets `rejectUnauthorized: true` and checks the authority hostname. A CA pin replaces public roots. Without a pin, `sslmode=verify-full` uses Node's default certificate store, including startup-loaded `NODE_EXTRA_CA_CERTS` and enabled system roots. A process-wide TLS verification opt-out does not override the client policy.

Neon's connection API returns `sslmode=require&channel_binding=require`. This driver's SCRAM implementation does not support channel binding. The derived URL therefore removes that unsupported parameter and explicitly selects `verify-full`; the actual connection verifies the chain and hostname using the root store above. This does not claim channel binding support.

The role-age constant lives in `worker/github/RoleAge.ts` and is re-exported by `RepoRoles.ts`, preserving its public API while keeping the standalone expiry command independent of unrelated app initialization.

Standalone CLI tests cover refusal before network access and credential-free diagnostics. An owned TLS Postgres fixture covers a Neon-shaped URL with the process root store, untrusted issuers, hostname mismatches, CA pins, and a global verification opt-out. Missing PostgreSQL/OpenSSL tools produce explicit skips; Latitude execution receipts belong in the work note.

This is an operations infrastructure boundary, not a product feature plugin. Library catalog entry: Effect SQL through the existing database layer; no new dependency or SQL implementation.


Astra repair: standalone migrations, deploy migrations, lane readiness and all release-host database subprocesses use the same policy. `infra/Postgres.migrationUrl` normalizes Neon’s API URI through `neonConnectionUri`; `ChatMigrations` and `db/migrate.ts` call `Connection.migrate`. Electric keeps its separate existing URI adapter. The pure Node policy lives in `ops/database/Policy.ts`, shared by the Effect connection wrapper and native libpq callers. libpq promotes pinned `require` to `verify-full` (its `require` alone does not verify the hostname), uses system roots without a pin, and discards ambient `PG*` connection overrides. Release-host configurations now require explicit Postgres URLs.

Driver messages are never public diagnostics. Only fixed policy errors or a fixed operation-failed message naming the hostname are printed. The lane probe carries its URL in the subprocess environment and prints only the hostname; its persistent log receives the same safe output. Earlier gate versions could have recorded a real URL at `$HOME/lanes/$LANE.gates.log` and in caller-captured stdout. Production certificate-chain verification belongs to Will and is not established by the generated-CA fixture.

The shared `Connection.migrate` boundary replaces migration failure causes, including driver defects, with a fresh host-only error before returning to Alchemy or the CLI. Raw errors are discarded rather than attached as nested causes. The deployment regression exercises Alchemy's actual Neon URI adapter and the real driver's invalid numeric-option parser, and checks formatted, serialized and inspected failure output for URLs and credentials.
