// Static server for the plain host: the pages plus the SDK's IIFE build, as a CDN would serve it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../../../dist');
const port = Number(process.argv[2] ?? 4801);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };
const pages = { '/': 'index.html', '/second': 'second.html' };

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const file = pages[path]
    ? join(here, pages[path])
    : path.startsWith('/dist/')
      ? join(dist, normalize(path.slice(6)).replace(/^(\.\.[/\\])+/, ''))
      : join(here, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`plain host on http://localhost:${port}`));
