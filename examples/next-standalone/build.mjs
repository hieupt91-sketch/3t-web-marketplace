import { mkdirSync, writeFileSync } from 'node:fs';
// Simulates `next build` with output: 'standalone': the server file already exists
// in .next/standalone/ in this fixture; the build step just stamps it.
mkdirSync('.next/standalone', { recursive: true });
writeFileSync('.next/standalone/BUILD_STAMP', 'built by next-standalone fixture\n');
