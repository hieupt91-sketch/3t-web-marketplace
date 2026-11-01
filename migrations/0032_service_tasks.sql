-- 0032: service tasks — the follow-up work a paid service package creates
-- for the team. First kind: 'installation' (the separate configuration /
-- installation package a buyer can add to a purchase). Fulfilment inserts
-- a pending task; staff work it from the admin operations queue and mark
-- it done — the buyer sees the status on their order.
CREATE TABLE service_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('installation')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id)
);
CREATE INDEX service_tasks_status_idx ON service_tasks (status, created_at);
