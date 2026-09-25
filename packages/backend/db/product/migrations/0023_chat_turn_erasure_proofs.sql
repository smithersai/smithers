-- Key erasure tombstones by the proof that wrote them.
--
-- Admission is unique per (user_id, run_id, leg_id), so one public turn
-- identity can be admitted by several accounts, each under its own replay
-- token. A tombstone keyed by identity alone let the first proof reserve the
-- identity: another account's valid proof was refused, and a proof written
-- before admission blocked every other account's admission of that identity.
-- A tombstone now fences only the proof that wrote it.
ALTER TABLE chat_turn_erasures DROP CONSTRAINT chat_turn_erasures_pkey;
ALTER TABLE chat_turn_erasures ADD PRIMARY KEY (run_id, leg_id, access_hash);
