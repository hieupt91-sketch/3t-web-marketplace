-- 0033: the domain package's paid-through horizon per site. Buying the
-- domain (at checkout with hosting, or on its own for an existing site)
-- sets/extends this: monthly +1 month, yearly +1 year, one-time = the
-- far-future sentinel. NULL = the domain package was never bought for
-- this site. Informational + renewal anchor (no auto-suspension).
ALTER TABLE sites ADD COLUMN domain_paid_until timestamptz;
