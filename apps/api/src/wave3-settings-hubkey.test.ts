import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, stepUp, ORIGIN, type TestContext } from './test-helpers.ts';

/**
 * Wave 3 — payments L5: enabling bank transfer requires a hub key.
 * Without one, checkout opens but no hub webhook can ever authenticate,
 * so money would arrive and never settle automatically. The key may come
 * from the save payload OR from the stored setting (stored sealed at
 * rest since v47 — a sealed value counts as set). Legacy rows that are
 * already enabled-without-key surface a warning flag on GET.
 */
let ctx: TestContext;
let ownerCookie: string;

const BANK = { bank_name: 'Vietcombank', bank_bin: '970436', account_number: '0123456789', account_holder: 'WEBMAKET TEST' };

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'w3-settings-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  await stepUp(ctx, ownerCookie); // payment settings saves require step-up
}, 120_000);
afterAll(async () => ctx.close());

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });
const post = (url: string, payload: unknown, cookie: string) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie } });

describe('L5: enabling bank transfer requires a hub key', () => {
  it('rejects enabling with complete bank details but no hub key anywhere', async () => {
    const res = await post('/api/v1/admin/settings/payment', { enabled: true, ...BANK }, ownerCookie);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe('settings.bank_transfer_hub_key_required');
    expect(res.json().error.field_errors).toContainEqual({ field: 'hub_api_key', code: 'required' });
    // Nothing was saved: the method stays disabled.
    const back = await get('/api/v1/admin/settings/payment', ownerCookie);
    expect(back.json().data).toMatchObject({ enabled: false, hub_configured: false, enabled_without_hub_key: false });
  });

  it('accepts enabling when the payload carries the hub key', async () => {
    const res = await post('/api/v1/admin/settings/payment', { enabled: true, ...BANK, hub_api_key: 'w3-hub-key-1' }, ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ enabled: true, hub_configured: true, enabled_without_hub_key: false });
    expect(res.body).not.toContain('w3-hub-key-1');
  });

  it('accepts a later enable-save without the key in the payload — the stored sealed key counts', async () => {
    const { rows } = await ctx.db.query<{ value_json: { hub_api_key: string } }>(
      "SELECT value_json FROM settings WHERE key = 'payment.bank_transfer'",
    );
    expect(rows[0]!.value_json.hub_api_key.startsWith('enc:v1:')).toBe(true);
    const res = await post('/api/v1/admin/settings/payment', { enabled: true, ...BANK }, ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.hub_configured).toBe(true);
  });

  it('surfaces enabled_without_hub_key on GET for legacy enabled-without-key data, and still refuses to re-save it enabled', async () => {
    // Simulate pre-L5 data: enabled with an empty hub key, written directly.
    await ctx.db.query(
      `INSERT INTO settings (key, value_json) VALUES ('payment.bank_transfer', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json`,
      [JSON.stringify({ enabled: true, ...BANK, hub_api_key: '' })],
    );
    const back = await get('/api/v1/admin/settings/payment', ownerCookie);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().data).toMatchObject({ enabled: true, hub_configured: false, enabled_without_hub_key: true });

    const resave = await post('/api/v1/admin/settings/payment', { enabled: true, ...BANK }, ownerCookie);
    expect(resave.statusCode, resave.body).toBe(422);
    expect(resave.json().error.code).toBe('settings.bank_transfer_hub_key_required');

    // Disabling never requires a key.
    const off = await post('/api/v1/admin/settings/payment', { enabled: false, ...BANK }, ownerCookie);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().data).toMatchObject({ enabled: false, enabled_without_hub_key: false });
  });
});
