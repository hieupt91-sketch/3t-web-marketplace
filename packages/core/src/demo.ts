/**
 * Fixed PUBLIC demo credentials for isolated-admin demo sessions (owner
 * request): every visitor of a demo session can log into the template's own
 * admin with this account and edit freely — the session copy is throwaway,
 * so nothing here is a secret and nothing survives the session. Shared by
 * the API (which reports the credentials to the visitor) and the worker
 * (which seeds the account into the freshly spawned session copy through
 * the template family's own first-run setup flow).
 */
export const DEMO_ADMIN_USERNAME = 'admin';
export const DEMO_ADMIN_PASSWORD = 'Demo1234';
