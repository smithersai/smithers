ALTER TABLE users ADD COLUMN is_synthetic BOOLEAN NOT NULL DEFAULT false;

UPDATE users SET is_synthetic = true
WHERE lower_username IN ('smithers-canary', 'codeplanesmithers', 'smithers-observer')
   OR user_type = 'service';
