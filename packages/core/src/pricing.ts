import type { Queryable } from './db.ts';

export type DeploymentMode = 'selfhost' | 'hosted';
export type PriceInterval = 'one_time' | 'monthly' | 'yearly';

export interface CurrentPrice {
  interval: PriceInterval;
  amount_minor: string;
  currency: string;
}

export interface PublicPlan {
  id: string;
  code: string;
  deployment_mode: DeploymentMode;
  name: Record<string, string>;
  limits: Record<string, unknown>;
  prices: CurrentPrice[];
}

/** A price is current when now is within [effective_from, effective_to). amount is kept as a string. */
const CURRENT_PRICE_SQL = `
  SELECT pp.plan_id, pp.interval, pp.amount_minor::text AS amount_minor, pp.currency
  FROM plan_prices pp
  WHERE pp.plan_id = ANY($1::uuid[]) AND pp.currency = $2
    AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())`;

/** Load active plans with their current prices for the given currency. */
export async function loadActivePlans(db: Queryable, templateId: string, currency: string): Promise<PublicPlan[]> {
  const { rows: planRows } = await db.query<{ id: string; code: string; deployment_mode: DeploymentMode; name_json: Record<string, string>; limits_json: Record<string, unknown> }>(
    `SELECT id, code, deployment_mode, name_json, limits_json FROM plans
     WHERE template_id = $1 AND status = 'active' ORDER BY deployment_mode, code`,
    [templateId],
  );
  if (planRows.length === 0) return [];
  const ids = planRows.map((p) => p.id);
  const { rows: priceRows } = await db.query<{ plan_id: string } & CurrentPrice>(CURRENT_PRICE_SQL, [ids, currency]);
  const byPlan = new Map<string, CurrentPrice[]>();
  for (const price of priceRows) {
    const list = byPlan.get(price.plan_id) ?? [];
    list.push({ interval: price.interval, amount_minor: price.amount_minor, currency: price.currency });
    byPlan.set(price.plan_id, list);
  }
  return planRows
    .map((plan) => ({ id: plan.id, code: plan.code, deployment_mode: plan.deployment_mode, name: plan.name_json, limits: plan.limits_json, prices: byPlan.get(plan.id) ?? [] }))
    // A plan with no current price in this currency cannot be offered.
    .filter((plan) => plan.prices.length > 0);
}

/** "From" price per deployment mode: the lowest current amount a buyer would first pay. */
export function startingPrices(plans: PublicPlan[]): { deployment_mode: DeploymentMode; amount_minor: string; currency: string; interval: PriceInterval }[] {
  const byMode = new Map<DeploymentMode, { amount: bigint; price: CurrentPrice }>();
  for (const plan of plans) {
    for (const price of plan.prices) {
      const amount = BigInt(price.amount_minor);
      const current = byMode.get(plan.deployment_mode);
      if (!current || amount < current.amount) byMode.set(plan.deployment_mode, { amount, price });
    }
  }
  return [...byMode.entries()].map(([deployment_mode, { price }]) => ({ deployment_mode, amount_minor: price.amount_minor, currency: price.currency, interval: price.interval }));
}

export interface PublishGate {
  code: string;
  passed: boolean;
}

export interface PublishReadiness {
  ready: boolean;
  gates: PublishGate[];
}

/**
 * Publish gates (docs/03 §10, A09). A template may be published only when every gate passes:
 * a ready version with a working preview, a published default-locale translation, at least one
 * active plan with a current price, and an export mode per offered deployment mode.
 */
export async function publishReadiness(db: Queryable, templateId: string, defaultLocale: string, currency: string): Promise<PublishReadiness> {
  const { rows: tplRows } = await db.query<{ published_version_id: string | null; manifest_json: { export?: { modes?: string[] } } | null }>(
    `SELECT t.published_version_id,
            (SELECT v.manifest_json FROM template_versions v WHERE v.template_id = t.id ORDER BY v.created_at DESC LIMIT 1) AS manifest_json
     FROM templates t WHERE t.id = $1`,
    [templateId],
  );
  const template = tplRows[0];
  const gates: PublishGate[] = [];

  const { rows: versionRows } = await db.query<{ version_id: string }>(
    `SELECT v.id AS version_id FROM template_versions v
     JOIN previews p ON p.version_id = v.id AND p.status = 'active'
     WHERE v.template_id = $1 AND v.status IN ('ready', 'published') ORDER BY v.created_at DESC LIMIT 1`,
    [templateId],
  );
  const readyVersion = versionRows[0]?.version_id ?? null;
  gates.push({ code: 'demo_ready', passed: readyVersion !== null });

  const { rows: trRows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM template_translations WHERE template_id = $1 AND locale = $2 AND status = 'published') AS ok`,
    [templateId, defaultLocale],
  );
  gates.push({ code: 'default_translation', passed: trRows[0]?.ok ?? false });

  const plans = await loadActivePlans(db, templateId, currency);
  gates.push({ code: 'has_priced_plan', passed: plans.length > 0 });

  const exportModes = new Set(template?.manifest_json?.export?.modes ?? []);
  const offeredModes = new Set(plans.map((p) => p.deployment_mode));
  const exportOk = offeredModes.size > 0 && [...offeredModes].every((mode) => exportModes.has(mode));
  gates.push({ code: 'export_modes', passed: exportOk });

  return { ready: readyVersion !== null && gates.every((g) => g.passed), gates };
}
