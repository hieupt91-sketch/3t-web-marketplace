-- Audit payments M3: a wallet direct sale is inserted as 'pending' and only
-- becomes 'completed' after the phase-2 settlement succeeds. A crash
-- between the phase-1 wallet debit and settlement used to leave the row
-- claiming 'completed' with the wallet charged and nothing delivered;
-- pending rows are recoverable — the worker sweep refunds them.
ALTER TABLE partner_wallet_sales DROP CONSTRAINT partner_wallet_sales_status_check;
ALTER TABLE partner_wallet_sales ADD CONSTRAINT partner_wallet_sales_status_check
  CHECK (status IN ('pending', 'completed', 'refunded'));
ALTER TABLE partner_wallet_sales ALTER COLUMN status SET DEFAULT 'pending';
