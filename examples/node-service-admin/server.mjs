// Fixture: a runtime template with the pilot family's first-run bootstrap —
// no admin exists at first boot, so the app writes a one-time setup token to
// data/setup-token.txt; POST /admin/setup creates the account; the admin can
// then edit the home-page headline stored in data/content.json.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const adminFile = join(dataDir, 'admin.json');
const tokenFile = join(dataDir, 'setup-token.txt');
const contentFile = join(dataDir, 'content.json');
if (!existsSync(contentFile)) writeFileSync(contentFile, JSON.stringify({ headline: 'Xin chào' }));
if (!existsSync(adminFile)) writeFileSync(tokenFile, randomBytes(16).toString('hex'));

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const hash = (s) => createHash('sha256').update(s).digest('hex');
const form = async (req) => Object.fromEntries(new URLSearchParams(await new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => resolve(b));
})));
const redirect = (res, to, cookie) => {
  res.writeHead(302, { location: to, ...(cookie ? { 'set-cookie': cookie } : {}) });
  res.end();
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><body><h1>${readJson(contentFile).headline}</h1></body></html>`);
  }
  if (url.pathname === '/admin/setup' && req.method === 'POST') {
    const fields = await form(req);
    const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
    if (!token || fields.token !== token) { res.writeHead(400); return res.end('bad token'); }
    writeFileSync(adminFile, JSON.stringify({ username: fields.username, pass: hash(fields.password ?? '') }));
    rmSync(tokenFile, { force: true });
    return redirect(res, '/admin/login');
  }
  if (url.pathname === '/admin/login' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html><body><form method="post" action="/admin/login"><input name="username"><input name="password" type="password"><button>Đăng nhập</button></form></body></html>');
  }
  if (url.pathname === '/admin/login' && req.method === 'POST') {
    const fields = await form(req);
    const admin = existsSync(adminFile) ? readJson(adminFile) : null;
    if (admin && fields.username === admin.username && hash(fields.password ?? '') === admin.pass) {
      return redirect(res, '/admin/', 'dsess=fixture-session; HttpOnly; Path=/');
    }
    return redirect(res, '/admin/login?err=1');
  }
  const authed = (req.headers.cookie ?? '').includes('dsess=fixture-session');
  if (url.pathname === '/admin/' && req.method === 'GET') {
    if (!authed) return redirect(res, '/admin/login');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><body><h1>Quản trị fixture</h1><form method="post" action="/admin/save"><input name="headline" value="${readJson(contentFile).headline}"><button>Lưu</button></form></body></html>`);
  }
  if (url.pathname === '/admin/save' && req.method === 'POST') {
    if (!authed) return redirect(res, '/admin/login');
    const fields = await form(req);
    writeFileSync(contentFile, JSON.stringify({ headline: String(fields.headline ?? '') }));
    return redirect(res, '/admin/');
  }
  res.writeHead(404);
  res.end('not found');
}).listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
