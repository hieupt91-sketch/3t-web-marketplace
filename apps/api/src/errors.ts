/** Error contract (docs/04 §1). `code` is stable and untranslated; UI translates by code. */
export interface FieldError {
  field: string;
  code: string;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly fieldErrors: FieldError[] = [],
    public readonly retryable = false,
    public readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

export const errors = {
  badRequest: (code = 'request.malformed') => new AppError(400, code),
  unauthenticated: (code = 'auth.session_required') => new AppError(401, code),
  forbidden: (code = 'auth.forbidden') => new AppError(403, code),
  notFound: (code = 'resource.not_found') => new AppError(404, code),
  conflict: (code: string, retryable = false) => new AppError(409, code, [], retryable),
  preconditionFailed: () => new AppError(412, 'resource.revision_conflict'),
  validation: (fieldErrors: FieldError[], code = 'validation.failed') => new AppError(422, code, fieldErrors),
  tooMany: (retryAfterSeconds: number) =>
    new AppError(429, 'rate_limit.exceeded', [], true, { 'retry-after': String(retryAfterSeconds) }),
};
