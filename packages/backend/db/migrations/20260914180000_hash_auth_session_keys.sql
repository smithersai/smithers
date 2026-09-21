-- Session cookies remain UUID bearer credentials. Store only their SHA-256
-- digest, including existing sessions, so a database dump cannot log in.
-- Deploy with the hash-aware auth service/middleware; old binaries cannot
-- authenticate against this representation. PostgreSQL sha256 is built in.
ALTER TABLE auth_sessions
    ALTER COLUMN session_key TYPE TEXT
    USING encode(sha256(convert_to(session_key::text, 'UTF8')), 'hex');
