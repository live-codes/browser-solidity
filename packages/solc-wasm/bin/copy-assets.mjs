#!/usr/bin/env node
// Copies everything a browser needs into a directory you serve.
//
// This is the browser story: a page cannot read a file inside node_modules, and it cannot reach the
// official release host either, so the assets have to be published by whatever serves the page. One
// command drops a complete, self-describing copy into your public directory; point `baseUrl` at it and
// nothing else has to be hosted.
//
// Unlike clang-wasm there is no `assets/` in this package to copy - the compiler ships inside the `solc`
// dependency, and re-vendoring it would mean two 9.2 MB copies that can drift. So it is read out of
// node_modules here, checked against the pinned receipt as it is written, and the two bundles come from
// this package's `dist/`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySoljson } from '../src/assets.js';
import { packagedAssets } from '../src/packaged.node.js';
import { ASSET_RECEIPTS } from '../src/receipts.js';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const BUNDLES = ['solc-wasm.global.js', 'solc-wasm-toolchain.global.js'];

const USAGE = `Copy the assets a browser needs into a directory you serve.

  solc-wasm-copy-assets [directory]

  directory      where to write them (default: ./solc)

  --print-path   print where this package's bundles live, and exit
  --help         print this
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}
if (args.includes('--print-path')) {
	console.log(DIST);
	process.exit(0);
}

const target = resolve(args.find((arg) => !arg.startsWith('-')) ?? 'solc');

await mkdir(target, { recursive: true });

for (const name of BUNDLES) {
	await writeFile(resolve(target, name), await readFile(resolve(DIST, name)));
}

// The compiler, checked before it is written rather than after: a copy that does not match the receipt
// would only fail much later, at `importScripts`, with a much less useful message.
const soljson = await packagedAssets.readFile('soljson.js');
await verifySoljson(soljson, 'soljson.js');
await writeFile(resolve(target, 'soljson.js'), soljson);

// The copy carries the receipts for its own bytes, so whoever serves it can check it.
await writeFile(resolve(target, 'asset-receipts.json'), `${JSON.stringify(ASSET_RECEIPTS, null, 2)}\n`);

console.log(`Wrote soljson.js (${soljson.byteLength} bytes) and ${BUNDLES.length} bundles to ${target}`);
console.log('Serve that directory and pass its URL as baseUrl, for example:');
console.log("  await createCompiler({ baseUrl: new URL('/solc/', location.href) });");
