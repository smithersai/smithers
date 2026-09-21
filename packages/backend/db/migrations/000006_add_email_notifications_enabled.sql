-- Add email_notifications_enabled preference to users table.
-- Default TRUE so existing users receive email notifications unless they opt out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;
