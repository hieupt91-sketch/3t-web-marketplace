import type { FastifyInstance } from 'fastify';
import { writeAudit } from '@3t/core';
import { requirePermission } from '../app.ts';
import { errors } from '../errors.ts';

export interface ContactChannels {
  phone: string;
  zalo: string;
  messenger: string;
  email: string;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Contact channels shown by the always-visible contact widget. Managed by
 *  the platform owner (settings:manage); empty channels are simply hidden. */
export async function adminSettingsRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get('/settings/contact', async (request) => {
    requirePermission(request, 'settings:manage');
    const { rows } = await db.query<{ value_json: Partial<ContactChannels> }>(
      "SELECT value_json FROM settings WHERE key = 'contact.channels'",
    );
    const raw = rows[0]?.value_json ?? {};
    return {
      data: {
        phone: clean(raw.phone),
        zalo: clean(raw.zalo),
        messenger: clean(raw.messenger),
        email: clean(raw.email),
      },
    };
  });

  app.post<{ Body: Partial<ContactChannels> }>(
    '/settings/contact',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            phone: { type: 'string', maxLength: 40 },
            zalo: { type: 'string', maxLength: 120 },
            messenger: { type: 'string', maxLength: 120 },
            email: { type: 'string', maxLength: 254 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'settings:manage');
      const next: ContactChannels = {
        phone: clean(request.body.phone),
        zalo: clean(request.body.zalo),
        messenger: clean(request.body.messenger),
        email: clean(request.body.email),
      };
      if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
        throw errors.validation([{ field: 'email', code: 'invalid' }]);
      }
      if (next.phone && !/^[+0-9][0-9\s.()-]*$/.test(next.phone)) {
        throw errors.validation([{ field: 'phone', code: 'invalid' }]);
      }
      await db.query(
        `INSERT INTO settings (key, value_json) VALUES ('contact.channels', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, revision = settings.revision + 1`,
        [JSON.stringify(next)],
      );
      await writeAudit(db, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'settings.contact_updated',
        resourceType: 'settings',
        resourceId: 'contact.channels',
        traceId: request.id,
      });
      return reply.status(200).send({ data: next });
    },
  );

  app.get('/settings/subdomain-fee', async (request) => {
    requirePermission(request, 'settings:manage');
    const { rows } = await db.query<{ value_json: { amount_minor?: number | null; period?: string } }>(
      "SELECT value_json FROM settings WHERE key = 'subdomain.fee'",
    );
    const raw = rows[0]?.value_json ?? {};
    return {
      data: {
        amount_minor: typeof raw.amount_minor === 'number' ? raw.amount_minor : null,
        period: raw.period === 'monthly' ? 'monthly' : 'once',
      },
    };
  });

  app.post<{ Body: { amount_minor?: number | null; period?: string } }>(
    '/settings/subdomain-fee',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            amount_minor: { type: ['integer', 'null'] },
            period: { enum: ['once', 'monthly'] },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'settings:manage');
      const amount = request.body.amount_minor ?? null;
      const period = request.body.period === 'monthly' ? 'monthly' : 'once';
      if (amount !== null && (!Number.isInteger(amount) || amount <= 0)) {
        throw errors.validation([{ field: 'amount_minor', code: 'invalid' }]);
      }
      const next = { amount_minor: amount, period };
      await db.query(
        `INSERT INTO settings (key, value_json) VALUES ('subdomain.fee', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, revision = settings.revision + 1`,
        [JSON.stringify(next)],
      );
      await writeAudit(db, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'settings.subdomain_fee_updated',
        resourceType: 'settings',
        resourceId: 'subdomain.fee',
        traceId: request.id,
      });
      return reply.status(200).send({ data: next });
    },
  );
}
