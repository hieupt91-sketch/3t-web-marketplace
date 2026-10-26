// Tiny static file server for hosted static sites (local runtime only).
// Usage: node serve-dir.mjs <dir>. Serves index.html at / and per-file content
// types; blocks .. and dotfiles, never lists directories. PORT/HOST from env.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('serve-dir: missing dir');
  process.exit(2);
}
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const rel = normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    if (rel.split(sep).some((part) => part.startsWith('.'))) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let file = join(root, rel === '' ? 'index.html' : rel);
    const info = await stat(file).catch(() => null);
    if (!info) {
      file = join(root, 'index.html');
      const fallback = await stat(file).catch(() => null);
      if (!fallback || !fallback.isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
    } else if (info.isDirectory()) {
      file = join(file, 'index.html');
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end('error');
  }
});
server.listen(Number(process.env.PORT || 0), process.env.HOST || '127.0.0.1');
