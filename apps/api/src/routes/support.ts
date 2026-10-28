import type { FastifyInstance } from 'fastify';
import { writeAudit } from '@3t/core';
import { requirePermission, requireUser } from '../app.ts';
import { errors } from '../errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function assertId(id: string) {
  if (!UUID.test(id)) throw errors.notFound();
}

async function hasSupportReply(db: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> }, userId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1 AND p.code = 'support:reply' LIMIT 1`,
    [userId],
  );
  return (res.rowCount ?? 0) > 0;
}

function ticketView(row: Record<string, unknown>) {
  return {
    ...row,
    sla_breached: row.status !== 'resolved' && row.status !== 'closed' && new Date(row.sla_due_at as string) < new Date(),
  };
}

/**
 * A26 support tickets (docs/03 §10, docs/05 A26).
 * Messages are stored plain text and never trigger external actions: no email,
 * webhook, refund, or site change happens on create/reply/assign/close.
 * Staff replies are stored in the ticket's locale (the customer's locale).
 */
export async function supportRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.post<{ Body: { subject: string; body: string; locale: 'vi' | 'en'; order_id?: string; site_label?: string } }>(
    '/support/tickets',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['subject', 'body', 'locale'], properties: { subject: { type: 'string', minLength: 3, maxLength: 200 }, body: { type: 'string', minLength: 3, maxLength: 10000 }, locale: { enum: ['vi', 'en'] }, order_id: { type: 'string' }, site_label: { type: 'string', maxLength: 200 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      if (request.body.order_id) {
        assertId(request.body.order_id);
        const order = await db.query('SELECT 1 FROM orders WHERE id = $1 AND buyer_id = $2', [request.body.order_id, auth.userId]);
        if (order.rowCount === 0) throw errors.validation([{ field: 'order_id', code: 'not_found' }]);
      }
      const { rows } = await db.query<{ id: string }>(
        'INSERT INTO support_tickets (requester_id, subject, body, locale, order_id, site_label) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [auth.userId, request.body.subject, request.body.body, request.body.locale, request.body.order_id ?? null, request.body.site_label ?? null],
      );
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'support.ticket_created', resourceType: 'support_ticket', resourceId: rows[0]!.id, traceId: request.id });
      return reply.status(201).send({ data: { id: rows[0]!.id } });
    },
  );

  app.get('/support/tickets', async (request) => {
    const auth = requireUser(request);
    const { rows } = await db.query('SELECT * FROM support_tickets WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 100', [auth.userId]);
    return { data: rows.map(ticketView) };
  });

  app.get<{ Params: { id: string } }>('/support/tickets/:id', async (request) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const ticket = await db.query('SELECT * FROM support_tickets WHERE id = $1 AND requester_id = $2', [request.params.id, auth.userId]);
    if (!ticket.rows[0]) throw errors.notFound();
    const messages = await db.query('SELECT * FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at', [request.params.id]);
    return { data: { ...ticketView(ticket.rows[0]), messages: messages.rows } };
  });

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/support/tickets/:id/reply',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 10000 } } } } },
    async (request) => {
      const auth = requireUser(request);
      assertId(request.params.id);
      const ticket = await db.query<{ status: string; locale: string }>('SELECT status, locale FROM support_tickets WHERE id = $1 AND requester_id = $2', [request.params.id, auth.userId]);
      if (!ticket.rows[0]) throw errors.notFound();
      if (ticket.rows[0]!.status === 'closed') throw errors.conflict('support.closed');
      await db.query(
        "INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_id, body, locale) VALUES ($1, 'customer', $2, $3, $4)",
        [request.params.id, auth.userId, request.body.body, ticket.rows[0]!.locale],
      );
      await db.query("UPDATE support_tickets SET status = CASE WHEN status = 'waiting' THEN 'open' ELSE status END WHERE id = $1", [request.params.id]);
      return { data: { status: 'replied' } };
    },
  );

  app.post<{ Params: { id: string } }>('/support/tickets/:id/close', async (request) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const ticket = await db.query('SELECT 1 FROM support_tickets WHERE id = $1 AND requester_id = $2', [request.params.id, auth.userId]);
    if (!ticket.rows[0]) throw errors.notFound();
    await db.query("UPDATE support_tickets SET status = 'closed' WHERE id = $1", [request.params.id]);
    return { data: { status: 'closed' } };
  });
}

/** A26 admin queue: list, assign, reply, resolve/close. */
export async function adminSupportRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get<{ Querystring: { status?: string; assigned_to?: string } }>('/support', async (request) => {
    requirePermission(request, 'support:read');
    const params: unknown[] = [];
    const where: string[] = [];
    if (request.query.status) {
      params.push(request.query.status);
      where.push(`status = $${params.length}`);
    }
    if (request.query.assigned_to) {
      assertId(request.query.assigned_to);
      params.push(request.query.assigned_to);
      where.push(`assigned_to = $${params.length}`);
    }
    const { rows } = await db.query(`SELECT * FROM support_tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 100`, params);
    return { data: rows.map(ticketView) };
  });

  app.get<{ Params: { id: string } }>('/support/:id', async (request) => {
    requirePermission(request, 'support:read');
    assertId(request.params.id);
    const ticket = await db.query('SELECT * FROM support_tickets WHERE id = $1', [request.params.id]);
    if (!ticket.rows[0]) throw errors.notFound();
    const messages = await db.query('SELECT * FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at', [request.params.id]);
    return { data: { ...ticketView(ticket.rows[0]), messages: messages.rows } };
  });

  app.post<{ Params: { id: string }; Body: { staff_id: string } }>(
    '/support/:id/assign',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['staff_id'], properties: { staff_id: { type: 'string' } } } } },
    async (request) => {
      const auth = requirePermission(request, 'support:reply');
      assertId(request.params.id);
      assertId(request.body.staff_id);
      const ticket = await db.query('SELECT 1 FROM support_tickets WHERE id = $1', [request.params.id]);
      if (!ticket.rows[0]) throw errors.notFound();
      if (!(await hasSupportReply(db, request.body.staff_id))) throw errors.validation([{ field: 'staff_id', code: 'not_support_staff' }]);
      await db.query("UPDATE support_tickets SET assigned_to = $2, status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END WHERE id = $1", [request.params.id, request.body.staff_id]);
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'support.ticket_assigned', resourceType: 'support_ticket', resourceId: request.params.id, traceId: request.id, diff: { assigned_to: request.body.staff_id } });
      return { data: { status: 'assigned' } };
    },
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/support/:id/reply',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 10000 } } } } },
    async (request) => {
      const auth = requirePermission(request, 'support:reply');
      assertId(request.params.id);
      const ticket = await db.query<{ status: string; locale: string }>('SELECT status, locale FROM support_tickets WHERE id = $1', [request.params.id]);
      if (!ticket.rows[0]) throw errors.notFound();
      if (ticket.rows[0]!.status === 'closed') throw errors.conflict('support.closed');
      await db.query(
        "INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_id, body, locale) VALUES ($1, 'staff', $2, $3, $4)",
        [request.params.id, auth.userId, request.body.body, ticket.rows[0]!.locale],
      );
      await db.query("UPDATE support_tickets SET status = CASE WHEN status IN ('open', 'assigned') THEN 'waiting' ELSE status END WHERE id = $1", [request.params.id]);
      return { data: { status: 'replied' } };
    },
  );

  app.post<{ Params: { id: string }; Body: { status: 'resolved' | 'closed' | 'open' } }>(
    '/support/:id/status',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { enum: ['resolved', 'closed', 'open'] } } } } },
    async (request) => {
      requirePermission(request, 'support:reply');
      assertId(request.params.id);
      const ticket = await db.query('SELECT 1 FROM support_tickets WHERE id = $1', [request.params.id]);
      if (!ticket.rows[0]) throw errors.notFound();
      await db.query('UPDATE support_tickets SET status = $2 WHERE id = $1', [request.params.id, request.body.status]);
      return { data: { status: request.body.status } };
    },
  );
}
