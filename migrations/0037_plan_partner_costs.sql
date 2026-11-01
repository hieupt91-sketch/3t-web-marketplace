-- v30: the owner can pin an exact partner price per plan (in points).
-- When set, a wallet sale deducts exactly that many points — the
-- partner's own retail price never enters the platform's math. When
-- not set, the deduction falls back to the policy % cut on the listed
-- price, as before.
CREATE TABLE plan_partner_costs (
  plan_id uuid PRIMARY KEY REFERENCES plans(id),
  cost_points bigint NOT NULL CHECK (cost_points > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER plan_partner_costs_touch BEFORE UPDATE ON plan_partner_costs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
