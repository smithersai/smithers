-- Fine-grained import progress (2026-07-05). The import job's only public
-- state was the trinary status (cloning/ready/failed), so the UI toast sat on
-- "Mirroring repo…" for the whole multi-minute import. `stage` is updated at
-- each runImport boundary (resolving → creating_repo → cloning_github →
-- pushing_mirror → importing_refs → creating_bookmark →
-- provisioning_workspace) and streams to clients through the existing
-- import-job SSE poll. Free-form TEXT, additive: older clients ignore it, and
-- stage writes are best-effort (a failed write never fails the import).
ALTER TABLE import_jobs ADD COLUMN stage TEXT NOT NULL DEFAULT '';
