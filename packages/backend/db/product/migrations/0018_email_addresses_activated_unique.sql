-- An unverified address proves nothing about who owns it, so it must not
-- reserve the address for every other account. Cross-account uniqueness now
-- applies only to activated rows; (user_id, lower_email) stays unique.
ALTER TABLE ONLY public.email_addresses
    DROP CONSTRAINT email_addresses_lower_email_key;

CREATE UNIQUE INDEX uq_email_addresses_activated_lower_email
    ON public.email_addresses USING btree (lower_email)
    WHERE (is_activated = true);
