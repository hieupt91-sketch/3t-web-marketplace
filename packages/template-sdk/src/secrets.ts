import { open } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Secret scan before build (docs/03 §5 step 6). Findings carry the path and rule only —
 * matched values are never returned or logged.
 */
export interface SecretFinding {
  path: string;
  rule: string;
}

const FILE_RULES: { rule: string; test: (name: string, path: string) => boolean }[] = [
  { rule: 'dotenv_file', test: (name) => /^\.env(\..+)?$/.test(name) && !/^\.env\.(example|sample|template)$/.test(name) },
  { rule: 'private_key_file', test: (name) => /\.(pem|key|p12|pfx|jks|keystore)$/i.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) },
  { rule: 'database_file', test: (name) => /\.(sqlite3?|db|sql\.gz|dump)$/i.test(name) },
  { rule: 'credentials_file', test: (name) => ['.npmrc', '.pypirc', '.netrc', '.htpasswd', 'credentials.json', 'service-account.json'].includes(name) },
];

const CONTENT_RULES: { rule: string; pattern: RegExp }[] = [
  { rule: 'private_key_block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { rule: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'github_token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { rule: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'stripe_live_key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { rule: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'database_url_with_password', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:[^\s@/]{3,}@/ },
];

const TEXT_EXTENSIONS = /\.(html?|css|m?js|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|cfg|conf|env|txt|md|xml|svg|php|py|rb|sh|properties)$/i;
const MAX_SCAN_BYTES = 1024 * 1024;

export async function scanForSecrets(root: string, files: { path: string; size: number }[]): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const name = file.path.split('/').pop() ?? file.path;
    for (const rule of FILE_RULES) {
      if (rule.test(name, file.path)) findings.push({ path: file.path, rule: rule.rule });
    }
    if (!TEXT_EXTENSIONS.test(name) && !name.startsWith('.env')) continue;
    const handle = await open(join(root, ...file.path.split('/')), 'r');
    try {
      const buffer = Buffer.alloc(Math.min(file.size, MAX_SCAN_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.toString('utf8');
      for (const rule of CONTENT_RULES) {
        if (rule.pattern.test(text)) findings.push({ path: file.path, rule: rule.rule });
      }
    } finally {
      await handle.close();
    }
  }
  return findings;
}
