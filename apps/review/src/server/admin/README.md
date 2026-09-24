# admin/

Operator endpoints, each authenticated with a constant-time Bearer
`ADMIN_TOKEN` check. The check is deliberately repeated per handler so every
file stays self-contained and auditable for a security-sensitive comparison.

- `handleAdminRepos.ts` — upsert/list repo registrations, including
  month-to-date usage per repo.
- `handleAdminKeys.ts` — mint `srk_` api keys and revoke by SHA-256 hash. The plaintext is returned
  exactly once; only the SHA-256 hash is stored, and there is no list
  endpoint by design.
- `handleAdminUsage.ts` — daily `usage_events` summary in UTC day buckets, bounded to 30 days
  by default (`?days=1..90`).
