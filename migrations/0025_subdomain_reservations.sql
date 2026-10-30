-- 0025 Subdomain reservations with TTL (docs/12 DEP-06).
--
-- Checking a name stays free and non-binding; a signed-in customer who is
-- about to deploy can HOLD the name for a short window so two customers
-- racing for the same name cannot both pass the check (UX-12). Creating
-- the site consumes the hold. Expired holds are released lazily by the
-- API (any read treats an expired hold as free and marks it) and in bulk
-- by a periodic worker sweep.
--
-- The TTL is a platform setting so the owner can tune it without a
-- deploy: settings key 'subdomain.reservation', { ttl_minutes }.
-- Default 15 minutes — long enough to finish the deploy form, short
-- enough that a forgotten hold frees the name quickly. NOT a price or a
-- policy: holding a name never charges the subdomain fee.
CREATE TABLE subdomain_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subdomain text NOT NULL CHECK (subdomain ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement_id uuid REFERENCES entitlements(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'released', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one ACTIVE hold per name; the API also checks first, the index
-- is the race-proof backstop (a loser gets a unique violation → 409).
CREATE UNIQUE INDEX subdomain_reservations_active_uq ON subdomain_reservations (subdomain) WHERE status = 'active';
CREATE INDEX subdomain_reservations_user_idx ON subdomain_reservations (user_id, status, expires_at);
CREATE TRIGGER subdomain_reservations_touch BEFORE UPDATE ON subdomain_reservations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

INSERT INTO settings (key, value_json) VALUES ('subdomain.reservation', '{"ttl_minutes": 15}'::jsonb)
ON CONFLICT (key) DO NOTHING;
