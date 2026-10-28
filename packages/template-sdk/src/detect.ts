import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IMPLEMENTED_ADAPTERS, MANIFEST_FILE, type Adapter } from './manifest.ts';

/**
 * Adapter detection without executing anything (docs/03 §4.1): only file names,
 * package metadata parsed as JSON data, and bounded text reads.
 */
export type Confidence = 'declared' | 'high' | 'medium' | 'low';

export type DetectionStatus = 'detected' | 'needs_configuration' | 'unsupported';

export interface Candidate {
  adapter: Adapter;
  projectRoot: string;
  confidence: Confidence;
}

export interface DetectionResult {
  status: DetectionStatus;
  adapter: Adapter | null;
  projectRoot: string | null;
  confidence: Confidence | null;
  candidates: Candidate[];
  /** Stable machine-readable signals, e.g. "package_json", "lockfile:pnpm-lock.yaml". */
  signals: string[];
  /** JSON pointers the admin still has to provide. */
  missingFields: string[];
  /** Why the package cannot proceed automatically (machine code). */
  reason: string | null;
  manifestPresent: boolean;
  /** Whether the chosen adapter is implemented in this release. */
  adapterImplemented: boolean | null;
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;
const MAX_PACKAGE_JSON = 1024 * 1024;

const UNSUPPORTED_MARKERS: { signal: string; test: (files: string[]) => boolean }[] = [
  { signal: 'php', test: (f) => f.some((p) => p.endsWith('.php')) || f.includes('composer.json') },
  { signal: 'wordpress', test: (f) => f.some((p) => p.endsWith('wp-config.php') || p.endsWith('wp-config-sample.php')) },
  { signal: 'laravel', test: (f) => f.includes('artisan') },
  { signal: 'python', test: (f) => f.some((p) => /(^|\/)(requirements\.txt|pyproject\.toml|manage\.py|Pipfile)$/.test(p)) },
  { signal: 'ruby', test: (f) => f.some((p) => /(^|\/)Gemfile$/.test(p)) },
];

const NON_EXECUTABLE = /\.(png|jpe?g|gif|webp|avif|svg|psd|fig|sketch|xd|pdf|sql|ai|eps|tiff?|txt|md|docx?|zip)$/i;

async function readPackageJson(root: string, path: string): Promise<Record<string, unknown> | null> {
  const full = join(root, ...path.split('/'));
  const info = await stat(full);
  if (info.size > MAX_PACKAGE_JSON) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(full, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function dependencyNames(pkg: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[key];
    if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '.' : path.slice(0, index);
}

function result(partial: Partial<DetectionResult> & Pick<DetectionResult, 'status'>): DetectionResult {
  const adapter = partial.adapter ?? null;
  return {
    adapter,
    projectRoot: null,
    confidence: null,
    candidates: [],
    signals: [],
    missingFields: [],
    reason: null,
    manifestPresent: false,
    adapterImplemented: adapter ? IMPLEMENTED_ADAPTERS.includes(adapter) : null,
    ...partial,
  };
}

export async function detectAdapter(root: string, filePaths: string[], declaredAdapter?: Adapter | null): Promise<DetectionResult> {
  const files = [...filePaths].sort();
  const fileSet = new Set(files);
  const signals: string[] = [];
  const manifestPresent = fileSet.has(MANIFEST_FILE);
  if (manifestPresent) signals.push('manifest');

  if (declaredAdapter) {
    return result({
      status: 'detected',
      adapter: declaredAdapter,
      confidence: 'declared',
      signals,
      manifestPresent,
    });
  }

  for (const marker of UNSUPPORTED_MARKERS) if (marker.test(files)) signals.push(`unsupported:${marker.signal}`);
  const hasDockerfile = files.some((p) => /(^|\/)Dockerfile$/.test(p));
  if (hasDockerfile) signals.push('dockerfile');
  const lockfiles = LOCKFILES.filter((l) => fileSet.has(l));
  for (const l of lockfiles) signals.push(`lockfile:${l}`);

  if (signals.some((s) => s.startsWith('unsupported:'))) {
    return result({ status: 'unsupported', signals, reason: 'framework_unsupported', manifestPresent });
  }

  if (fileSet.has('package.json')) {
    signals.push('package_json');
    const pkg = await readPackageJson(root, 'package.json');
    if (!pkg) return result({ status: 'needs_configuration', signals, reason: 'package_json_unreadable', manifestPresent, missingFields: ['/adapter'] });
    const deps = dependencyNames(pkg);
    const frameworks: Adapter[] = [];
    if (deps.has('vite')) frameworks.push('vite-static');
    if (deps.has('next')) frameworks.push('next-standalone');
    for (const other of ['react-scripts', '@angular/core', 'nuxt', '@sveltejs/kit', 'astro', 'gatsby', '@remix-run/node']) {
      if (deps.has(other)) signals.push(`framework:${other}`);
    }
    for (const f of frameworks) signals.push(`framework:${f}`);
    const missingFields: string[] = [];
    if (lockfiles.length === 0) missingFields.push('/build/lockfile');
    if (lockfiles.length > 1) signals.push('multiple_lockfiles');

    // A complete Next static export can be imported as static HTML.
    if (frameworks.length === 1 && frameworks[0] === 'next-standalone' && fileSet.has('out/index.html')) {
      const candidate: Candidate = { adapter: 'static-html', projectRoot: 'out', confidence: 'medium' };
      return result({
        status: 'needs_configuration',
        adapter: 'static-html',
        projectRoot: 'out',
        confidence: 'medium',
        candidates: [candidate, { adapter: 'next-standalone', projectRoot: '.', confidence: 'low' }],
        signals: [...signals, 'next_static_export'],
        missingFields: ['/slug', '/version', '/name'],
        reason: 'confirm_static_export',
        manifestPresent,
      });
    }
    if (frameworks.length !== 1 || lockfiles.length > 1 || signals.some((s) => s.startsWith('framework:') && !s.endsWith('-static') && !s.endsWith('-standalone'))) {
      return result({
        status: 'needs_configuration',
        candidates: frameworks.map((adapter) => ({ adapter, projectRoot: '.', confidence: 'low' as const })),
        signals,
        missingFields: ['/adapter', ...missingFields],
        reason: frameworks.length > 1 ? 'multiple_frameworks' : lockfiles.length > 1 ? 'multiple_lockfiles' : 'framework_unrecognized',
        manifestPresent,
      });
    }
    const adapter = frameworks[0] as Adapter;
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, unknown>;
    if (typeof scripts.build !== 'string') missingFields.push('/build/script');
    missingFields.push('/build/toolchain');
    if (adapter !== 'vite-static') missingFields.push('/runtime/port', '/runtime/start', '/runtime/healthPath');
    return result({
      status: 'needs_configuration',
      adapter,
      projectRoot: '.',
      confidence: 'medium',
      candidates: [{ adapter, projectRoot: '.', confidence: 'medium' }],
      signals,
      missingFields: ['/slug', '/version', '/name', ...missingFields],
      reason: 'build_configuration_required',
      manifestPresent,
    });
  }

  if (hasDockerfile) {
    return result({ status: 'unsupported', signals, reason: 'container_recipe_unreviewed', manifestPresent });
  }

  const htmlDirs = [...new Set(files.filter((p) => p.endsWith('/index.html') || p === 'index.html').map(dirOf))];
  if (htmlDirs.length === 0) {
    const onlyNonExecutable = files.every((p) => NON_EXECUTABLE.test(p));
    return result({
      status: 'unsupported',
      signals,
      reason: onlyNonExecutable ? 'no_executable_entry' : 'entry_not_found',
      manifestPresent,
    });
  }
  signals.push('index_html');
  // Prefer the shallowest index.html; ambiguity among equally shallow roots needs a human choice.
  const depth = (d: string) => (d === '.' ? 0 : d.split('/').length);
  const minDepth = Math.min(...htmlDirs.map(depth));
  const shallowest = htmlDirs.filter((d) => depth(d) === minDepth);
  if (shallowest.length > 1) {
    return result({
      status: 'needs_configuration',
      adapter: 'static-html',
      candidates: shallowest.map((projectRoot) => ({ adapter: 'static-html' as const, projectRoot, confidence: 'low' as const })),
      signals,
      missingFields: ['/projectRoot'],
      reason: 'project_root_ambiguous',
      manifestPresent,
    });
  }
  const projectRoot = shallowest[0] as string;
  const confidence: Confidence = projectRoot === '.' ? 'high' : 'medium';
  return result({
    status: 'detected',
    adapter: 'static-html',
    projectRoot,
    confidence,
    candidates: [{ adapter: 'static-html', projectRoot, confidence }],
    signals,
    manifestPresent,
  });
}
