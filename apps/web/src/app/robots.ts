import type { MetadataRoute } from 'next';
import { siteBaseUrl } from '@/lib/seo';

/** Private areas stay disallowed for every crawler; robots is not a substitute for auth (docs/07 §7). */
const PRIVATE_PATHS = ['/admin', '/account', '/auth', '/checkout', '/demo', '/api'];

/**
 * Search + AI crawlers are explicitly welcome on public pages so the store can be indexed and
 * cited by AI assistants (ChatGPT, Claude, Perplexity, Gemini, Copilot). They get the same
 * private-path disallows as everyone else — an Allow here never opens /admin or /account.
 * Includes the 2026 search agents (OAI-SearchBot, Claude-SearchBot) next to the training ones.
 */
const AI_AND_SEARCH_BOTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'Claude-Web',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'CCBot',
  'Bingbot',
  'cohere-ai',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: PRIVATE_PATHS },
      { userAgent: AI_AND_SEARCH_BOTS, allow: '/', disallow: PRIVATE_PATHS },
    ],
    sitemap: `${siteBaseUrl()}/sitemap.xml`,
  };
}
