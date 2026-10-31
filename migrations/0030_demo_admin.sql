-- 0030 Demo admin accounts for isolated-admin demo sessions (owner request, 2026-10-31).
--
-- Runtime demo sessions whose template declares demo.mode = 'isolatedAdmin'
-- get a throwaway demo admin account seeded by the platform into the
-- session's own copy (fixed public demo credentials), so visitors can log
-- into the template's admin, edit freely, and lose everything when the
-- session expires or resets. This flag records that the seeding succeeded
-- for the session; the credentials themselves are constants, never stored.
ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS demo_admin_ready boolean NOT NULL DEFAULT false;
