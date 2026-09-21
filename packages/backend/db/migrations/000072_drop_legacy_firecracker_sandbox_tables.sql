-- Drop the obsolete self-hosted Firecracker sandbox host fleet tables.
-- Agent, workspace, and workflow VM execution now use Freestyle provider IDs
-- on their owning rows. sandbox_access_tokens remains in use for Smithers-
-- scoped SSH and terminal tokens.

DROP TABLE IF EXISTS sandbox_operations;
DROP TABLE IF EXISTS sandbox_vms;
DROP TABLE IF EXISTS sandbox_hosts;
