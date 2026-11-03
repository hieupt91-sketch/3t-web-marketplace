-- 0042: a quote is consumed by its first live order (audit payments L3).
-- POST /orders locks the quote FOR UPDATE and rejects a second order in
-- code (error order.quote_consumed); this partial unique index is the
-- database backstop for every other order-creating path, so no code path
-- can mint two live orders from one priced quote.
--
-- Semantics (code and index agree exactly): an order in ANY status other
-- than 'cancelled' consumes its quote — awaiting_payment, paid, expired,
-- needs_reconciliation and the refund states all block a second order.
-- Only 'cancelled' frees the quote: the buyer backed out before paying,
-- and while the quote is still inside its own 15-minute TTL they may
-- order again from it. (An expired order still blocks, but by then the
-- quote itself has expired too, so the buyer simply creates a new quote.)
--
-- Deploy note: if production already holds duplicate non-cancelled
-- orders for one quote_id, CREATE UNIQUE INDEX will fail loudly rather
-- than silently pick a winner — resolve those rows before applying.
CREATE UNIQUE INDEX orders_quote_single_live_uq
  ON orders (quote_id)
  WHERE status <> 'cancelled';
