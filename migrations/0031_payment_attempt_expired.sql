-- 0031: payment attempts gain an explicit 'expired' state. When an order's
-- payment window lapses unpaid, its pending attempts move to 'expired' so
-- "not received" is a recorded fact, not an eternal 'pending' (owner rule
-- 2026-11-01: ~15-minute window, then the order auto-cancels, and any late
-- money is an admin confirmation from reconciliation).
ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
  CHECK (status IN ('created', 'pending', 'settled', 'failed', 'cancelled', 'expired'));
