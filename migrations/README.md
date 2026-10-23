# Platform SQL migrations

- Files are `NNNN_description.sql`, applied in order by `packages/core/src/migrate.ts` (`pnpm db:migrate`).
- Each file runs in its own transaction under an advisory lock and is recorded in `schema_migrations` with a SHA-256 checksum.
- **Forward-only:** never edit an applied file (the runner refuses a changed checksum). Fix mistakes with a new migration.
- Destructive changes need an expand → migrate data → contract sequence across releases so the previous app version keeps working during rollout; a non-backward-compatible change is rolled back by restore, not by running old code (AT-48).
- Tests create a throw-away database per test file and apply all migrations (`packages/core/src/testing.ts`).
