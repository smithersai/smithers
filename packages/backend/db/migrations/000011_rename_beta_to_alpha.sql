-- Rename closed-beta tables and indexes to closed-alpha.

ALTER TABLE beta_whitelist_entries RENAME TO alpha_whitelist_entries;
ALTER TABLE beta_waitlist_entries RENAME TO alpha_waitlist_entries;

ALTER INDEX idx_beta_whitelist_created_by RENAME TO idx_alpha_whitelist_created_by;
ALTER INDEX idx_beta_waitlist_status_created RENAME TO idx_alpha_waitlist_status_created;
ALTER INDEX idx_beta_waitlist_approved_by RENAME TO idx_alpha_waitlist_approved_by;
