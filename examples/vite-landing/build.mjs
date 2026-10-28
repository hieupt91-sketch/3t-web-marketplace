import { mkdirSync, writeFileSync } from 'node:fs';
// Simulates a bundler: the pipeline runs the manifest build script and serves outputDir.
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<!doctype html><html><head><meta charset="utf-8"><title>Vite landing</title></head><body><h1>Built by vite-static fixture</h1></body></html>\n');
