import { mkdirSync, writeFileSync } from 'node:fs';
// Simulates `next build` with output: 'standalone'. The build step itself must
// produce .next/standalone/server.js: that path is under the repo-wide `.next/`
// gitignore, so a pre-existing server file in the fixture never reaches a
// clean checkout (and CI failed with standalone_server_missing), while a
// local worktree that happened to have the file passed. Keep the fixture
// self-contained instead of relying on an ignored file.
mkdirSync('.next/standalone', { recursive: true });
writeFileSync('.next/standalone/BUILD_STAMP', 'built by next-standalone fixture\n');
writeFileSync(
  '.next/standalone/server.js',
  `const http = require('node:http');\n` +
    `const port = Number(process.env.PORT || 3000);\n` +
    `http.createServer((req, res) => {\n` +
    `  if (req.url === '/__health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }\n` +
    `  res.writeHead(200, { 'content-type': 'text/html' });\n` +
    `  res.end('<html><body><h1>Next standalone fixture</h1></body></html>');\n` +
    `}).listen(port, '127.0.0.1');\n`,
);
