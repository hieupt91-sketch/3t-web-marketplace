-- 0019 Admin show/hide flag for templates (quick pricing & visibility manager).
--
-- hidden = the template is not publicly visible at all: the public catalog
-- list/search, the public detail page and the preview image all treat it as
-- absent, and no new purchase can start. The published status is untouched,
-- so re-showing is instant and existing buyers keep their entitlements.
ALTER TABLE templates ADD COLUMN hidden boolean NOT NULL DEFAULT false;
