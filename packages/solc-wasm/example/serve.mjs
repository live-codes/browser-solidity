// A static server for the example. It exists because `file://` cannot run ES modules, spawn a worker or
// fetch the compiler - not because anything here needs special headers.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 4180);
// The package directory, so `/src/**`, `/dist/**` and `/example/**` are all reachable and the assets sit
// next to the page that uses them.
const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.css': 'text/css; charset=utf-8'
};

createServer(async (request, response) => {
	const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
	const file = normalize(join(ROOT, path === '/' ? '/example/index.html' : path));

	if (!file.startsWith(ROOT)) {
		response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
		return;
	}

	let body;
	try {
		body = await readFile(file);
	} catch {
		response.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${path}`);
		return;
	}

	response.writeHead(200, {
		'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
		'Content-Length': body.length,
		'Cache-Control': 'no-store'
	}).end(body);
}).listen(PORT, () => {
	console.log(`solc-wasm example: http://localhost:${PORT}/`);
	console.log('press Ctrl+C to stop');
});
