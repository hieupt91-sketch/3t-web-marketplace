import type { FastifyInstance } from 'fastify';
import { writeAudit } from '@3t/core';
import { requirePermission } from '../app.ts';
import { errors } from '../errors.ts';
import { loadBankTransferSettings } from './commerce.ts';

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
        // audit_logs.resource_id is uuid: a settings key is not a uuid, so
        // the action name identifies the setting and resource stays null.
        resourceId: null,
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
        // audit_logs.resource_id is uuid: a settings key is not a uuid, so
        // the action name identifies the setting and resource stays null.
        // (Passing the key here used to 500 with 22P02 AFTER the value was
        // already saved, so the UI reported failure for a successful save.)
        resourceId: null,
        traceId: request.id,
        diff: { amount_minor: amount, period },
      });
      return reply.status(200).send({ data: next });
    },
  );

  // DEP-06 hold duration. A duration, not a price: shortening or lengthening
  // it never charges anyone; new holds use the new value, existing holds
  // keep the expiry they were granted.
  app.get('/settings/subdomain-reservation', async (request) => {
    requirePermission(request, 'settings:manage');
    const { rows } = await db.query<{ value_json: { ttl_minutes?: number } }>(
      "SELECT value_json FROM settings WHERE key = 'subdomain.reservation'",
    );
    const raw = rows[0]?.value_json ?? {};
    return { data: { ttl_minutes: Number.isInteger(raw.ttl_minutes) && raw.ttl_minutes! >= 1 && raw.ttl_minutes! <= 1440 ? raw.ttl_minutes : 15 } };
  });

  app.post<{ Body: { ttl_minutes: number } }>(
    '/settings/subdomain-reservation',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ttl_minutes'],
          properties: { ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 } },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'settings:manage');
      const next = { ttl_minutes: request.body.ttl_minutes };
      await db.query(
        `INSERT INTO settings (key, value_json) VALUES ('subdomain.reservation', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, revision = settings.revision + 1`,
        [JSON.stringify(next)],
      );
      await writeAudit(db, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'settings.subdomain_reservation_updated',
        resourceType: 'settings',
        resourceId: null,
        traceId: request.id,
        diff: next,
      });
      return reply.status(200).send({ data: next });
    },
  );
}

/** Bank-transfer payment settings (owner proposal, 2026-10-30). The hub API
 *  key is a secret: it is accepted on POST (absent = keep, non-empty =
 *  replace) and never returned; GET reports only whether one is configured. */
export async function adminPaymentSettingsRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  app.get('/settings/payment', async (request) => {
    requirePermission(request, 'settings:manage');
    const s = await loadBankTransferSettings(db);
    return {
      data: {
        enabled: s.enabled,
        bank_name: s.bank_name,
        account_number: s.account_number,
        account_holder: s.account_holder,
        hub_configured: s.hub_api_key !== '',
        webhook_url: `${config.portalOrigin}/api/v1/payments/webhooks/bank_transfer`,
      },
    };
  });

  app.post<{ Body: { enabled?: boolean; bank_name?: string; account_number?: string; account_holder?: string; hub_api_key?: string } }>(
    '/settings/payment',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            bank_name: { type: 'string', maxLength: 120 },
            account_number: { type: 'string', maxLength: 40 },
            account_holder: { type: 'string', maxLength: 120 },
            hub_api_key: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'settings:manage');
      const current = await loadBankTransferSettings(db);
      const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
      const next = {
        enabled: request.body.enabled === true,
        bank_name: clean(request.body.bank_name),
        account_number: clean(request.body.account_number).replace(/\s+/g, ''),
        account_holder: clean(request.body.account_holder),
        hub_api_key: typeof request.body.hub_api_key === 'string' && request.body.hub_api_key.trim() !== ''
          ? request.body.hub_api_key.trim()
          : current.hub_api_key,
      };
      if (next.enabled) {
        const problems: { field: string; code: string }[] = [];
        if (!next.bank_name) problems.push({ field: 'bank_name', code: 'required' });
        if (!/^[0-9]{6,30}$/.test(next.account_number)) problems.push({ field: 'account_number', code: 'invalid' });
        if (!next.account_holder) problems.push({ field: 'account_holder', code: 'required' });
        if (problems.length > 0) throw errors.validation(problems);
      }
      await db.query(
        `INSERT INTO settings (key, value_json) VALUES ('payment.bank_transfer', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, revision = settings.revision + 1`,
        [JSON.stringify(next)],
      );
      await writeAudit(db, {
        actorType: 'user',
        actorId: auth.userId,
        action: 'settings.payment_updated',
        resourceType: 'settings',
        resourceId: null,
        traceId: request.id,
        // The account number and hub key never enter the audit diff.
        diff: { enabled: next.enabled, bank_name: next.bank_name, hub_key_changed: next.hub_api_key !== current.hub_api_key },
      });
      return reply.status(200).send({
        data: {
          enabled: next.enabled,
          bank_name: next.bank_name,
          account_number: next.account_number,
          account_holder: next.account_holder,
          hub_configured: next.hub_api_key !== '',
          webhook_url: `${config.portalOrigin}/api/v1/payments/webhooks/bank_transfer`,
        },
      });
    },
  );
}

/** Gateway merchant settings (VNPay + MoMo). Secret keys are write-only:
 *  a POST replaces the stored key only when a non-empty value is sent, and
 *  GET never returns one — only whether it is configured. Sandbox defaults
 *  on so the owner can verify with the gateway's test merchant first. */
export async function adminGatewaySettingsRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;
  const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  async function load(key: string) {
    const { rows } = await db.query<{ value_json: Record<string, unknown> }>('SELECT value_json FROM settings WHERE key = $1', [key]);
    return rows[0]?.value_json ?? {};
  }
  async function save(key: string, value: Record<string, unknown>) {
    await db.query(
      `INSERT INTO settings (key, value_json) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, revision = settings.revision + 1`,
      [key, JSON.stringify(value)],
    );
  }

  app.get('/settings/payment-vnpay', async (request) => {
    requirePermission(request, 'settings:manage');
    const raw = await load('payment.vnpay');
    return {
      data: {
        enabled: raw.enabled === true,
        tmn_code: clean(raw.tmn_code),
        secret_configured: clean(raw.secret_key) !== '',
        sandbox: raw.sandbox !== false,
        ipn_url: `${config.portalOrigin}/api/v1/payments/webhooks/vnpay`,
      },
    };
  });

  app.post<{ Body: { enabled?: boolean; tmn_code?: string; secret_key?: string; sandbox?: boolean } }>(
    '/settings/payment-vnpay',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            tmn_code: { type: 'string', maxLength: 30 },
            secret_key: { type: 'string', maxLength: 200 },
            sandbox: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'settings:manage');
      const current = await load('payment.vnpay');
      const next = {
        enabled: request.body.enabled === true,
        tmn_code: clean(request.body.tmn_code),
        secret_key: clean(request.body.secret_key) !== '' ? clean(request.body.secret_key) : clean(current.secret_key),
        sandbox: request.body.sandbox !== false,
      };
      if (next.enabled) {
        const problems: { field: string; code: string }[] = [];
        if (!/^[A-Za-z0-9]{4,30}$/.test(next.tmn_code)) problems.push({ field: 'tmn_code', code: 'invalid' });
        if (!next.secret_key) problems.push({ field: 'secret_key', code: 'required' });
        if (problems.length > 0) throw errors.validation(problems);
      }
      await save('payment.vnpay', next);
      await writeAudit(db, {
        actorType: 'user', actorId: auth.userId, action: 'settings.payment_vnpay_updated',
        resourceType: 'settings', resourceId: null, traceId: request.id,
        diff: { enabled: next.enabled, tmn_code: next.tmn_code, sandbox: next.sandbox, secret_changed: next.secret_key !== clean(current.secret_key) },
      });
      return reply.status(200).send({
        data: { enabled: next.enabled, tmn_code: next.tmn_code, secret_configured: next.secret_key !== '', sandbox: next.sandbox, ipn_url: `${config.portalOrigin}/api/v1/payments/webhooks/vnpay` },
      });
    },
  );

  app.get('/settings/payment-momo', async (request) => {
    requirePermission(request, 'settings:manage');
    const raw = await load('payment.momo');
    return {
      data: {
        enabled: raw.enabled === true,
        partner_code: clean(raw.partner_code),
        access_key: clean(raw.access_key),
        secret_configured: clean(raw.secret_key) !== '',
        sandbox: raw.sandbox !== false,
        ipn_url: `${config.portalOrigin}/api/v1/payments/webhooks/momo`,
      },
    };
  });

  app.post<{ Body: { enabled?: boolean; partner_code?: string; access_key?: string; secret_key?: string; sandbox?: boolean } }>(
    '/settings/payment-momo',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            partner_code: { type: 'string', maxLength: 60 },
            access_key: { type: 'string', maxLength: 120 },
            secret_key: { type: 'string', maxLength: 200 },
            sandbox: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'settings:manage');
      const current = await load('payment.momo');
      const next = {
        enabled: request.body.enabled === true,
        partner_code: clean(request.body.partner_code),
        access_key: clean(request.body.access_key),
        secret_key: clean(request.body.secret_key) !== '' ? clean(request.body.secret_key) : clean(current.secret_key),
        sandbox: request.body.sandbox !== false,
      };
      if (next.enabled) {
        const problems: { field: string; code: string }[] = [];
        if (!next.partner_code) problems.push({ field: 'partner_code', code: 'required' });
        if (!next.access_key) problems.push({ field: 'access_key', code: 'required' });
        if (!next.secret_key) problems.push({ field: 'secret_key', code: 'required' });
        if (problems.length > 0) throw errors.validation(problems);
      }
      await save('payment.momo', next);
      await writeAudit(db, {
        actorType: 'user', actorId: auth.userId, action: 'settings.payment_momo_updated',
        resourceType: 'settings', resourceId: null, traceId: request.id,
        diff: { enabled: next.enabled, partner_code: next.partner_code, sandbox: next.sandbox, secret_changed: next.secret_key !== clean(current.secret_key) },
      });
      return reply.status(200).send({
        data: { enabled: next.enabled, partner_code: next.partner_code, access_key: next.access_key, secret_configured: next.secret_key !== '', sandbox: next.sandbox, ipn_url: `${config.portalOrigin}/api/v1/payments/webhooks/momo` },
      });
    },
  );
}
