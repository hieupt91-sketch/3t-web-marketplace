import { createServer } from 'node:http';
const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => {
  if (req.url === '/__health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/admin') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>Demo admin</h1></body></html>');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body><h1>Node service home</h1></body></html>');
}).listen(port, '127.0.0.1');
