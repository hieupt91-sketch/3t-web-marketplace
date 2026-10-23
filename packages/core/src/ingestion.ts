/**
 * Import pipeline vocabulary shared by API and worker (docs/03 §5).
 * Step names and error codes are stable machine values; UI translates them.
 */
export const IMPORT_STEPS = [
  'authorize',
  'receive',
  'quarantine',
  'inspect_archive',
  'resolve_root',
  'secret_scan',
  'detect',
  'validate_manifest',
  'policy',
  'build',
  'inspect_output',
  'record',
  'provision_preview',
  'init_db',
  'health',
  'smoke',
  'screenshots',
  'ready',
] as const;

export type ImportStep = (typeof IMPORT_STEPS)[number];

export type ImportStatus =
  | 'received'
  | 'inspecting'
  | 'needs_configuration'
  | 'queued'
  | 'building'
  | 'provisioning'
  | 'validating'
  | 'ready'
  | 'failed'
  | 'rejected'
  | 'cancelled';

/** Outcome category per error code: rejected = package unusable as-is, needs_configuration = admin can fix. */
export const IMPORT_ERROR_OUTCOME: Record<string, 'rejected' | 'needs_configuration' | 'failed'> = {
  source_unavailable: 'failed',
  artifact_store_error: 'failed',
  archive_unsafe: 'rejected',
  archive_too_large: 'rejected',
  archive_invalid: 'rejected',
  project_root_ambiguous: 'needs_configuration',
  secret_detected: 'rejected',
  adapter_unsupported: 'rejected',
  manifest_invalid: 'needs_configuration',
  needs_configuration: 'needs_configuration',
  policy_denied: 'rejected',
  version_conflict: 'rejected',
  artifact_invalid: 'rejected',
  provision_failed: 'failed',
  health_failed: 'failed',
  smoke_failed: 'failed',
  persistence_failed: 'failed',
};

/** Codes worth an automatic retry (transient infrastructure failures). */
export const RETRYABLE_IMPORT_ERRORS = new Set(['source_unavailable', 'artifact_store_error', 'provision_failed', 'health_failed', 'persistence_failed', 'internal_error']);

export const IMPORT_JOB_TYPE = 'import.process';
