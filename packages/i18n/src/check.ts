/** CI gate (docs/07 §3): vi/en must expose the same keys and placeholder sets. */
import { MESSAGES, placeholders } from './index.ts';

const problems: string[] = [];
const vi = MESSAGES.vi;
const en = MESSAGES.en;
for (const key of Object.keys(vi)) if (!(key in en)) problems.push(`en missing ${key}`);
for (const key of Object.keys(en)) if (!(key in vi)) problems.push(`vi missing ${key}`);
for (const key of Object.keys(vi)) {
  if (!(key in en)) continue;
  const a = placeholders(vi[key] as string).join(',');
  const b = placeholders(en[key] as string).join(',');
  if (a !== b) problems.push(`placeholder mismatch ${key}: vi[${a}] en[${b}]`);
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(key)) problems.push(`non-semantic key ${key}`);
  if ((vi[key] as string).trim() === '' || (en[key] as string).trim() === '') problems.push(`empty message ${key}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS', keys: Object.keys(vi).length }));
