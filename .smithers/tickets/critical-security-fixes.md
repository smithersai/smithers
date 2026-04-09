# Critical security fixes

## Problem

Two critical security issues found during audit.

### 1. SQL injection via rawQuery (`src/db/adapter.ts:167-177`)

`rawQuery(queryString)` passes caller-supplied SQL directly to SQLite with zero
sanitization. The `SqliteBrowser` TUI component feeds user-typed SQL into it.
Any caller path with untrusted input enables DROP TABLE, data exfiltration, etc.

**Fix:** Restrict `rawQuery` to read-only statements (prefix with `EXPLAIN` or
use a read-only connection). At minimum, disallow DDL/DML keywords from the TUI.

### 2. Debug log leaks sensitive data (`src/engine/index.ts:3247-3251`)

`fs.appendFileSync("/tmp/smithers_debug.log", ...)` writes agent output (which
may contain API responses, PII, credentials) to a world-readable temp file.
This appears to be leftover debug code.

**Fix:** Remove this `appendFileSync` call entirely.

## Severity

**CRITICAL** — data loss/corruption risk and information disclosure.
