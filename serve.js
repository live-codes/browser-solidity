/**
 * A static server for this demo.
 *
 * It exists because `file://` cannot run ES modules, spawn a worker or fetch the compiler. Nothing
 * else is needed: the page runs with NO cross-origin isolation.
 *
 *   node serve.js [port]
 *
 * Three roots are mounted, because the page is a consumer of the package rather than a self-contained
 * demo any more:
 *
 *   /                -> public/                        the page itself
 *   /solc-wasm/      -> packages/solc-wasm/            the package, by its source path - what a
 *                                                      bundler or the published entry would resolve
 *   /solc-assets/    -> solc-assets/                   the compiler, written by solc-wasm-copy-assets
 *
 * The assets are generated, not committed: `npm start` writes them first.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const PORT = Number(argv.find((arg) => !arg.startsWith('-')) ?? 8127);
const ROOT = resolve(fileURLToPath(new URL('./', import.meta.url)));

const ROUTES = [
  { prefix: '/solc-wasm/', root: 'packages/solc-wasm' },
  { prefix: '/solc-assets/', root: 'solc-assets' },
  { prefix: '/', root: 'public' },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  // Longest matching prefix wins, so `/solc-wasm/...` is not served by the `/` route.
  const route = ROUTES.filter((candidate) => urlPath.startsWith(candidate.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )[0];
  const relative = urlPath.slice(route.prefix.length);
  const rootDir = resolve(ROOT, route.root);
  const filePath = normalize(join(rootDir, relative === '' ? 'index.html' : relative));

  if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }

  let body;
  try {
    body = await readFile(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${urlPath}`);
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // Nothing here is content-pinned, so serve everything fresh; the browser caches the CDN modules.
    'Cache-Control': 'no-store',
  }).end(body);
});

server.listen(PORT, () => {
  console.log(`browser-solidity: http://localhost:${PORT}/`);
  for (const route of ROUTES) {
    console.log(`  ${route.prefix.padEnd(15)} -> ${route.root}/`);
  }
  console.log('the compiler is served from /solc-assets/, the EVM comes from a CDN on first run');
  console.log('press Ctrl+C to stop');
});
