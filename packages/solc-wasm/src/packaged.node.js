// The Node half of the asset source: reading the compiler out of the installed `solc` package.
//
// This module is only reachable through the `node` condition in package.json, so a browser bundle never
// includes it and never trips over `node:fs`.
//
// The compiler is not vendored into this package's own `assets/` - it already ships, byte for byte,
// inside the `solc` dependency, and duplicating 9.2 MB to re-host it would mean two copies that can
// drift. `copy-assets` reads from here too, so what a browser is served is the same file Node runs.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// Resolve the package entry, then take `soljson.js` as its sibling: `solc` is CommonJS and may or may
// not expose the subpath, but the file is always next to the entry point. `pathToFileURL` is what makes
// this work on Windows, where a bare `new URL(path)` cannot.
const SOLJSON_PATH = fileURLToPath(new URL('soljson.js', pathToFileURL(require.resolve('solc'))));

export const SOLJSON_ON_DISK = SOLJSON_PATH;

export const packagedAssets = {
	description: `the soljson.js shipped by the installed solc package (${SOLJSON_PATH})`,
	readFile: async (name) => {
		if (name !== 'soljson.js') {
			throw new Error(`There is no packaged asset called ${name}`);
		}
		try {
			return new Uint8Array(await readFile(SOLJSON_PATH));
		} catch (error) {
			throw new Error(`Failed to read ${SOLJSON_PATH}: ${error.message}`, { cause: error });
		}
	}
};
