import type { FastifyInstance } from 'fastify';
import { requireUser } from '../app.ts';
import { errors } from '../errors.ts';

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  // Job progress for the owner or scoped staff; never exposes payload or commands (docs/04 §8).
  app.get<{ Params: { id: string } }>('/jobs/:id', async (request) => {
    const auth = requireUser(request);
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) throw errors.notFound();
    const { rows } = await db.query<{
      id: string;
      type: string;
      status: string;
      step: string | null;
      completed_steps: number;
      total_steps: number | null;
      attempts: number;
      max_attempts: number;
      last_error_code: string | null;
      resource_type: string | null;
      resource_id: string | null;
      owner_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>('SELECT * FROM jobs WHERE id = $1', [request.params.id]);
    const job = rows[0];
    const staffScope = job?.resource_type === 'import' ? 'template:read' : 'ops:read';
    if (!job || (job.owner_id !== auth.userId && !auth.permissions.has(staffScope))) throw errors.notFound();
    return {
      data: {
        id: job.id,
        type: job.type,
        status: job.status,
        step: job.step,
        completed_steps: job.completed_steps,
        total_steps: job.total_steps,
        attempts: job.attempts,
        retryable: job.status === 'queued' && job.attempts > 0,
        error_code: job.last_error_code,
        resource: job.resource_type ? { type: job.resource_type, id: job.resource_id } : null,
        created_at: job.created_at.toISOString(),
        updated_at: job.updated_at.toISOString(),
      },
      meta: { request_id: request.id, revision: null },
    };
  });
}
