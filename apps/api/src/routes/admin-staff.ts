import type { FastifyInstance } from 'fastify';
import { writeAudit } from '@3t/core';
import { requirePermission } from '../app.ts';
import { errors } from '../errors.ts';
import { requireStepUp } from '../lib/step-up.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Staff management (A24): grant/revoke roles on existing accounts.
 * - Never grant above the actor: every permission in a granted role must
 *   already be held by the actor (the platform owner holds all, so only an
 *   owner can grant owner-level roles).
 * - Never remove the last owner: revoking platform_owner from its last
 *   holder is rejected.
 * - All mutations require step-up.
 */
export async function adminStaffRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get('/staff', async (request) => {
    requirePermission(request, 'staff:manage');
    const { rows } = await db.query(
      `SELECT u.id, u.email_normalized AS email, u.display_name, u.status,
              COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
              (m.verified_at IS NOT NULL) AS mfa_enabled
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       LEFT JOIN user_mfa m ON m.user_id = u.id
       GROUP BY u.id, m.verified_at ORDER BY u.created_at DESC LIMIT 200`,
    );
    return { data: rows };
  });

  app.get<{ Params: { id: string } }>('/staff/:id', async (request) => {
    requirePermission(request, 'staff:manage');
    if (!UUID.test(request.params.id)) throw errors.notFound();
    const { rows } = await db.query(
      `SELECT u.id, u.email_normalized AS email, u.display_name, u.status,
              COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
              COALESCE(array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions,
              (m.verified_at IS NOT NULL) AS mfa_enabled
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       LEFT JOIN user_mfa m ON m.user_id = u.id
       WHERE u.id = $1 GROUP BY u.id, m.verified_at`,
      [request.params.id],
    );
    if (!rows[0]) throw errors.notFound();
    return { data: rows[0] };
  });

  app.post<{ Params: { id: string }; Body: { role_code: string } }>(
    '/staff/:id/roles',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['role_code'], properties: { role_code: { type: 'string', minLength: 1, maxLength: 60 } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'staff:manage');
      await requireStepUp(db, auth);
      if (!UUID.test(request.params.id)) throw errors.notFound();
      const target = await db.query('SELECT id FROM users WHERE id = $1 AND status = $2', [request.params.id, 'active']);
      if (!target.rows[0]) throw errors.notFound();
      const role = await db.query<{ id: string }>('SELECT id FROM roles WHERE code = $1', [request.body.role_code]);
      if (!role.rows[0]) throw errors.notFound();
      const rolePerms = await db.query<{ code: string }>(
        'SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1',
        [role.rows[0].id],
      );
      const beyond = rolePerms.rows.filter((p) => !auth.permissions.has(p.code));
      if (beyond.length > 0) throw errors.forbidden('staff.grant_above_actor');
      await db.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [request.params.id, role.rows[0].id],
      );
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'staff.role_granted', resourceType: 'user', resourceId: request.params.id, traceId: request.id, diff: { role: request.body.role_code } });
      return reply.status(201).send({ data: { user_id: request.params.id, role_code: request.body.role_code } });
    },
  );

  app.delete<{ Params: { id: string; roleCode: string } }>('/staff/:id/roles/:roleCode', async (request, reply) => {
    const auth = requirePermission(request, 'staff:manage');
    await requireStepUp(db, auth);
    if (!UUID.test(request.params.id)) throw errors.notFound();
    const role = await db.query<{ id: string }>('SELECT id FROM roles WHERE code = $1', [request.params.roleCode]);
    if (!role.rows[0]) throw errors.notFound();
    if (request.params.roleCode === 'platform_owner') {
      const holders = await db.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM user_roles WHERE role_id = $1',
        [role.rows[0].id],
      );
      const isHolder = await db.query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2', [request.params.id, role.rows[0].id]);
      if (holders.rows[0]!.n === '1' && isHolder.rows[0]) throw errors.conflict('staff.last_owner');
    }
    const { rowCount } = await db.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [request.params.id, role.rows[0].id]);
    if (rowCount === 0) throw errors.notFound();
    await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'staff.role_revoked', resourceType: 'user', resourceId: request.params.id, traceId: request.id, diff: { role: request.params.roleCode } });
    return reply.status(200).send({ data: { user_id: request.params.id, role_code: request.params.roleCode, revoked: true } });
  });
}
