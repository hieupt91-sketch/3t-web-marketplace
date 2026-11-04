/**
 * IndexNow submission for the webmaket storefront (www-less host webmaket.com).
 *
 * The key file is hosted by the web app at
 * apps/web/public/f93d1b0371a611353b5c7c3e2d7872f4.txt (its content is the key
 * itself), which is what lets this API submit on behalf of the host: one POST
 * to api.indexnow.org fans out to Bing, Yandex, Naver and Seznam. Google does
 * not participate in IndexNow. The key is public by design (anyone can read
 * the key file), so it is not a secret and may appear in code and logs.
 *
 * Submission is a ranking-freshness hint, never part of a business
 * transaction: callers fire-and-forget (`void pingIndexNow(...)`) after the
 * mutation commits, and this function never throws and never blocks.
 * Production only — local/dev/test runs stay silent unless explicitly opted
 * in with INDEXNOW_ENABLED=true (same env-reading convention as
 * packages/core/src/config.ts: process.env, APP_ENV defaulting away from
 * production).
 */
export const INDEXNOW_HOST = 'webmaket.com';
export const INDEXNOW_KEY = 'f93d1b0371a611353b5c7c3e2d7872f4';
const INDEXNOW_KEY_LOCATION = `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`;
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
/** Protocol limit: at most 10,000 URLs per submission. */
const MAX_URLS_PER_SUBMISSION = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;

export function indexNowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APP_ENV === 'production' || env.INDEXNOW_ENABLED === 'true';
}

/**
 * The public URLs whose existence/content changes when a template is
 * published, archived (unpublished) or hidden/unhidden: its detail page in
 * both storefront locales plus both catalog listing pages. Submitting a URL
 * that now 404s is also correct — the engines re-crawl and drop it.
 */
export function storefrontTemplateUrls(slug: string): string[] {
  return [
    `https://${INDEXNOW_HOST}/vi/templates/${slug}`,
    `https://${INDEXNOW_HOST}/en/templates/${slug}`,
    `https://${INDEXNOW_HOST}/vi/templates`,
    `https://${INDEXNOW_HOST}/en/templates`,
  ];
}

/**
 * Build the submission body: only URLs on the key's host are submittable
 * (the protocol binds a key to one host), duplicates are dropped and the
 * list is capped at the protocol limit. Returns null when nothing remains.
 */
export function buildIndexNowPayload(urls: string[]): { host: string; key: string; keyLocation: string; urlList: string[] } | null {
  const seen = new Set<string>();
  const urlList: string[] = [];
  for (const raw of urls) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.hostname !== INDEXNOW_HOST) continue;
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    urlList.push(url);
    if (urlList.length >= MAX_URLS_PER_SUBMISSION) break;
  }
  if (urlList.length === 0) return null;
  return { host: INDEXNOW_HOST, key: INDEXNOW_KEY, keyLocation: INDEXNOW_KEY_LOCATION, urlList };
}

/**
 * Fire-and-forget IndexNow submission. Resolves in every case: disabled
 * environments and empty lists are silent no-ops, network/HTTP failures are
 * logged and swallowed. One structured log line per attempt (status + URL
 * count; never the request body).
 */
export async function pingIndexNow(urls: string[]): Promise<void> {
  try {
    if (!indexNowEnabled()) return;
    const payload = buildIndexNowPayload(urls);
    if (!payload) return;
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    console.log(JSON.stringify({ event: 'indexnow_ping', status: res.status, urls: payload.urlList.length }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'indexnow_failed', error: error instanceof Error ? error.name : 'unknown' }));
  }
}
