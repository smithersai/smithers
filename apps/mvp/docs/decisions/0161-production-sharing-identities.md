# 0161 — Production sharing proofs require distinct live identities

Date: 2026-11-04. Implements TEST-1, TEST-4, TEST-6, BR-1 and BR-4; requested by Will in lane e2e-sharing.

Sharing and two-person coediting must run against production rather than permanently skip on the local-only `devPeople` prerequisite. The tests accept separately provisioned GitHub test-account sessions, verify both live person ids and logins, and verify each collaborator's role on the fixture repository before opening its page. Local tests retain developer-person cookies; deployment tests never use them. Missing identity configuration blocks acceptance, and a bad configured identity fails verification.

The Member journey proves view, edit and revocation. The Guest journey proves that a repository link grants no Guest access and a named edit grant never exceeds Guest view access. Dedicated scratch branches isolate these grants from the private conversation used by other production tests. Cleanup removes the fixture grants even after failure. Independent sockets and direct API probes make authorization observable beyond what the UI renders.

The existing implementation remains the public-library implementation: the catalog's `@smthrs/sync` entry supplies presence and shared text. This change adds test infrastructure only; it changes no product permission, runtime, plugin interface or library choice. A production pass still requires provisioned real accounts and executed receipts.
