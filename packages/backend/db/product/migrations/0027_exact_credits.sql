-- Exact platform credit in integer USD nanos (1 USD = 1e9 nanos), held per
-- owner (user or organization) independently of any payment customer.
--
-- Every spendable amount is a grant with an optional expiry. Model calls
-- reserve a bound against grants before spending and settle once. Legacy
-- accounts with no verified owner are kept as sealed accounts, never dropped.

CREATE TABLE credit_accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_type text CHECK (owner_type IN ('user', 'org')),
    owner_id bigint CHECK (owner_id > 0),
    debt_nanos bigint NOT NULL DEFAULT 0 CHECK (debt_nanos >= 0),
    disposition text NOT NULL DEFAULT 'owned'
        CHECK (disposition IN ('owned', 'owner_unknown', 'owner_missing', 'merged')),
    merged_into bigint REFERENCES credit_accounts(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_type, owner_id),
    CHECK ((owner_type IS NULL) = (owner_id IS NULL)),
    CHECK ((disposition = 'owned') = (owner_id IS NOT NULL)),
    CHECK ((disposition = 'merged') = (merged_into IS NOT NULL))
);

CREATE TABLE credit_grants (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES credit_accounts(id),
    source_key text NOT NULL CHECK (source_key <> ''),
    original_nanos bigint NOT NULL CHECK (original_nanos >= 0),
    available_nanos bigint NOT NULL CHECK (available_nanos >= 0),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, source_key),
    CHECK (available_nanos <= original_nanos)
);

CREATE TABLE credit_reservations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES credit_accounts(id),
    request_key text NOT NULL CHECK (request_key <> ''),
    reserved_nanos bigint NOT NULL CHECK (reserved_nanos > 0),
    charged_nanos bigint CHECK (charged_nanos >= 0),
    status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled', 'released')),
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    -- Settled at its bound because it stayed open past the abandon window.
    abandoned boolean NOT NULL DEFAULT false,
    UNIQUE (account_id, request_key),
    CHECK ((status = 'reserved' AND charged_nanos IS NULL AND settled_at IS NULL) OR
           (status <> 'reserved' AND charged_nanos IS NOT NULL AND settled_at IS NOT NULL)),
    CHECK ((status = 'released') = (charged_nanos = 0))
);

CREATE INDEX idx_credit_reservations_open ON credit_reservations (created_at) WHERE status = 'reserved';

CREATE TABLE credit_reservation_grants (
    reservation_id bigint NOT NULL REFERENCES credit_reservations(id),
    grant_id bigint NOT NULL REFERENCES credit_grants(id),
    reserved_nanos bigint NOT NULL CHECK (reserved_nanos > 0),
    charged_nanos bigint CHECK (charged_nanos >= 0 AND charged_nanos <= reserved_nanos),
    PRIMARY KEY (reservation_id, grant_id)
);

-- Append-only movement log. The sum of available_delta_nanos per grant equals
-- its available_nanos; debt_delta_nanos per account equals its debt_nanos.
CREATE TABLE credit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES credit_accounts(id),
    grant_id bigint REFERENCES credit_grants(id),
    reservation_id bigint REFERENCES credit_reservations(id),
    kind text NOT NULL
        CHECK (kind IN ('import', 'grant', 'reserve', 'settle', 'release', 'expire', 'overage', 'debt', 'merge')),
    available_delta_nanos bigint NOT NULL,
    spent_nanos bigint NOT NULL DEFAULT 0 CHECK (spent_nanos >= 0),
    debt_delta_nanos bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_credit_events_account ON credit_events (account_id, id);
CREATE INDEX idx_credit_events_grant ON credit_events (grant_id) WHERE grant_id IS NOT NULL;

-- One receipt per legacy billing source. raw_account holds the exact archived
-- record bytes; checksum is their SHA-256 and pins every replay. account_id follows
-- the source when a sealed account is later attached to its owner.
CREATE TABLE credit_legacy_imports (
    source_id text PRIMARY KEY CHECK (source_id <> ''),
    account_id bigint NOT NULL REFERENCES credit_accounts(id),
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    raw_account text NOT NULL CHECK (raw_account::jsonb IS NOT NULL),
    opening_debt_nanos bigint NOT NULL DEFAULT 0 CHECK (opening_debt_nanos >= 0),
    disposition text NOT NULL CHECK (disposition IN ('owned', 'owner_unknown', 'owner_missing')),
    imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_credit_legacy_imports_account ON credit_legacy_imports (account_id);

-- Carry the integer-cent balances into the exact ledger, then retire the
-- cent balance table. billing_credit_ledger stays as the audit history.
INSERT INTO credit_accounts (owner_type, owner_id)
SELECT DISTINCT b.owner_type, b.owner_id
FROM billing_accounts b
WHERE b.id IN (
    SELECT billing_account_id FROM billing_credit_balances
    UNION
    SELECT billing_account_id FROM billing_credit_ledger WHERE category = 'monthly_grant'
);

CREATE TEMPORARY TABLE carried_cents AS
SELECT a.id AS account_id, cb.balance_cents
FROM billing_credit_balances cb
JOIN billing_accounts b ON b.id = cb.billing_account_id
JOIN credit_accounts a ON a.owner_type = b.owner_type AND a.owner_id = b.owner_id;

WITH carried AS (
    INSERT INTO credit_grants (account_id, source_key, original_nanos, available_nanos)
    SELECT account_id, 'cents-balance', balance_cents * 10000000, balance_cents * 10000000
    FROM carried_cents
    WHERE balance_cents > 0
    RETURNING id, account_id, available_nanos
)
INSERT INTO credit_events (account_id, grant_id, kind, available_delta_nanos)
SELECT account_id, id, 'import', available_nanos FROM carried;

WITH owed AS (
    UPDATE credit_accounts a
    SET debt_nanos = -c.balance_cents * 10000000
    FROM carried_cents c
    WHERE a.id = c.account_id AND c.balance_cents < 0
    RETURNING a.id, a.debt_nanos
)
INSERT INTO credit_events (account_id, kind, available_delta_nanos, debt_delta_nanos)
SELECT id, 'debt', 0, debt_nanos FROM owed;

-- A month already granted in cents is spent or part of 'cents-balance'. Its
-- key is recorded with nothing available, so the month is not granted again.
INSERT INTO credit_grants (account_id, source_key, original_nanos, available_nanos)
SELECT a.id, l.idempotency_key, GREATEST(l.amount_cents, 0) * 10000000, 0::bigint
FROM billing_credit_ledger l
JOIN billing_accounts b ON b.id = l.billing_account_id
JOIN credit_accounts a ON a.owner_type = b.owner_type AND a.owner_id = b.owner_id
WHERE l.category = 'monthly_grant' AND l.idempotency_key <> '';

DO $$
DECLARE
    cents numeric;
    nanos numeric;
BEGIN
    SELECT COALESCE(sum(balance_cents), 0) * 10000000 INTO cents FROM billing_credit_balances;
    IF (SELECT count(*) FROM carried_cents) <> (SELECT count(*) FROM billing_credit_balances) THEN
        RAISE EXCEPTION 'cent balance rows without a billing account owner';
    END IF;
    SELECT COALESCE((SELECT sum(available_nanos) FROM credit_grants WHERE source_key = 'cents-balance'), 0)
         - COALESCE((SELECT sum(debt_nanos) FROM credit_accounts), 0)
    INTO nanos;
    IF cents <> nanos THEN
        RAISE EXCEPTION 'cent balance carry mismatch: % cents-as-nanos, % nanos', cents, nanos;
    END IF;
END $$;

DROP TABLE carried_cents;
DROP TABLE billing_credit_balances;
