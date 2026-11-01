-- v32: partner pricing simplified per owner decision — the wallet
-- deduction is a % cut on the listed price, set globally (policy) or
-- per category. The per-plan fixed pin (0037) is removed.
CREATE TABLE partner_category_discounts (
  category_id uuid PRIMARY KEY REFERENCES template_categories(id),
  discount_bps integer NOT NULL CHECK (discount_bps BETWEEN 0 AND 9000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER partner_category_discounts_touch BEFORE UPDATE ON partner_category_discounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TABLE plan_partner_costs;
