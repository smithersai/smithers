-- Revision: 20260808130000.
-- Attribute each worker heartbeat's compute aggregate to the controller-owned
-- placements that contributed to it. Admission can then add only genuinely
-- unknown observed capacity to allocated reservations instead of approximating
-- their set union with GREATEST(allocated, observed).
ALTER TABLE sandbox_instances
    ADD COLUMN IF NOT EXISTS compute_observed_at TIMESTAMPTZ;
