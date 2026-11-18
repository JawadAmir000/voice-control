// Serves app/ so the orb UI can be previewed in a browser (it runs a demo of all states).
//   npm run ui-preview  →  http://localhost:5178/orb.html   (?state=listening|thinking|acting|speaking|confirming)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const dir = path.resolve(import.meta.dirname, '..', 'app');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.css': 'text/css' };
createServer(async (req, res) => {
  const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(dir)) return res.writeHead(403).end();
  let body;
  try { body = await readFile(p); } catch { return res.writeHead(404).end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' }).end(body);
}).listen(5178, () => console.log('UI preview on http://localhost:5178/orb.html'));
