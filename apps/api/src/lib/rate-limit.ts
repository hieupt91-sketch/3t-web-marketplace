import { hashToken } from '@3t/core';
import type { FastifyRequest } from 'fastify';

/**
 * Shared per-route rate-limit configs (audit code M-05). Authenticated
 * surfaces key on the session cookie (hashed, never stored raw) so one
 * account cannot dodge the bucket by changing IP, with the IP as fallback
 * for anonymous calls; public surfaces key on IP. Limits are flood brakes
 * set far above legitimate use — the Postgres store keeps one bucket per
 * key across all API instances.
 */
export function sessionRateLimit(max: number, timeWindow = '15 minutes') {
  return {
    rateLimit: {
      max,
      timeWindow,
      keyGenerator: (req: FastifyRequest) => {
        const cookie = req.cookies?.mp_session;
        return cookie ? `${req.ip}|${hashToken(cookie).toString('hex').slice(0, 16)}` : req.ip;
      },
    },
  };
}

export function ipRateLimit(max: number, timeWindow = '15 minutes') {
  return {
    rateLimit: {
      max,
      timeWindow,
      keyGenerator: (req: FastifyRequest) => req.ip,
    },
  };
}
