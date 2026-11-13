// Local preview: node tools/serve.mjs [port]
// Also serves /mock-api/..., a stand-in for the GitHub contents API, so editing can be
// tried locally: saves are written straight to data/*.enc.json in this folder.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 4173;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const sha = (buf) => createHash('sha1').update(buf).digest('hex');
const json = (res, code, obj) => res.writeHead(code, { 'content-type': types['.json'] }).end(JSON.stringify(obj));

async function mockApi(req, res, pathname) {
  const m = pathname.match(/^\/mock-api\/repos\/[^/]+\/[^/]+\/contents\/(data\/[\w.-]+\.enc\.json)$/);
  if (!m) return json(res, 404, { message: 'Not Found' });
  const file = join(root, m[1]);
  const current = await readFile(file).catch(() => null);
  if (req.method === 'GET') {
    if (!current) return json(res, 404, { message: 'Not Found' });
    return json(res, 200, { sha: sha(current), encoding: 'base64', content: current.toString('base64') });
  }
  if (req.method === 'PUT') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (current && body.sha !== sha(current)) return json(res, 409, { message: 'sha does not match' });
    const next = Buffer.from(body.content, 'base64');
    await writeFile(file, next);
    return json(res, 200, { content: { sha: sha(next) } });
  }
  json(res, 405, { message: 'Method Not Allowed' });
}

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.startsWith('/mock-api/')) return mockApi(req, res, pathname).catch((e) => json(res, 500, { message: String(e) }));
  const path = normalize(pathname).replace(/^[\\/]+/, '') || 'index.html';
  if (path.startsWith('..') || path.startsWith('private') || path.startsWith('.')) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`));
