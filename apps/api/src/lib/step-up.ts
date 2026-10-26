import type { AuthContext } from '../app.ts';
import { errors } from '../errors.ts';

/**
 * Step-up authentication (docs/04 §5): sensitive actions require a session
 * elevation earned within the last 10 minutes by re-authenticating
 * (POST /auth/step-up with password, plus TOTP when MFA is verified).
 * The timestamp lives on the session row so every instance enforces it.
 */
export async function requireStepUp(
  db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  auth: AuthContext,
  maxAgeMinutes = 10,
): Promise<void> {
  const { rows } = await db.query<{ step_up_at: Date | null }>(
    'SELECT step_up_at FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()',
    [auth.sessionId],
  );
  const stepUpAt = rows[0]?.step_up_at;
  if (!stepUpAt || Date.now() - new Date(stepUpAt).getTime() > maxAgeMinutes * 60_000) {
    throw errors.forbidden('auth.step_up_required');
  }
}
