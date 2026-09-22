// Where the compiler assets come from, and how they are checked.
//
// Two sources behind one shape, because everything downstream only needs "give me soljson.js":
//
//   hosted   - a base URL you serve. Required in a browser, because a page cannot read a file inside
//              an npm package, and a worker cannot fetch the official release host either
//              (binaries.soliditylang.org sends no Access-Control-Allow-Origin).
//   packaged - the copy that ships inside the `solc` dependency, on disk. Node only.
//
// Unlike clang-wasm there is nothing to intercept: soljson.js is fetched and verified here, then handed
// to the runtime as a blob URL, so the bytes that get executed are the bytes that were checked.
import { ASSET_RECEIPTS } from './receipts.js';

const SOLJSON = 'soljson.js';

export function resolveAssetSource(options, packaged) {
	if (options.baseUrl != null && options.baseUrl !== '') {
		return createHostedSource(options);
	}
	if (!packaged) {
		throw new Error(
			'baseUrl is required here. The copy of soljson.js that ships in this package can only be ' +
				'read where there is a filesystem, and a browser cannot reach a file inside an npm ' +
				'package - copy it somewhere your page can fetch with `npx --package ' +
				'@live-codes/solc-wasm solc-wasm-copy-assets <dir>` and pass that directory as baseUrl.'
		);
	}
	return createPackagedSource(packaged);
}

function createHostedSource(options) {
	const baseUrl = resolveBaseUrl(options.baseUrl);
	return {
		kind: 'hosted',
		key: `hosted\u0000${baseUrl}`,
		description: baseUrl,
		baseUrl,
		soljsonUrl: new URL(SOLJSON, baseUrl).href,
		readSoljson: async ({ onProgress } = {}) => {
			const url = new URL(SOLJSON, baseUrl).href;
			let response;
			try {
				response = await fetch(url);
			} catch (error) {
				throw new Error(`Failed to fetch ${url}: ${error.message}`, { cause: error });
			}
			if (!response.ok) {
				throw new Error(`Failed to fetch ${url}: ${response.status}`);
			}
			return verifySoljson(await readWithProgress(response, onProgress), url);
		}
	};
}

/**
 * Read a response, reporting how far along it is when the length is known.
 *
 * Worth the loop rather than `response.arrayBuffer()`: this is 9.2 MB, the only thing a page waits on,
 * and a progress bar that jumps from 0 to 1 with a multi-second pause is not one.
 */
async function readWithProgress(response, onProgress) {
	if (!onProgress || !response.body) {
		return new Uint8Array(await response.arrayBuffer());
	}
	const total = Number(response.headers.get('content-length')) || 0;
	const chunks = [];
	let received = 0;
	for await (const chunk of response.body) {
		chunks.push(chunk);
		received += chunk.length;
		onProgress(total ? Math.min(1, received / total) : 0);
	}
	const bytes = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

function createPackagedSource(packaged) {
	return {
		kind: 'packaged',
		key: `packaged\u0000${packaged.description}`,
		description: packaged.description,
		baseUrl: null,
		soljsonUrl: null,
		readSoljson: async () => verifySoljson(await packaged.readFile(SOLJSON))
	};
}

/**
 * A base URL for the assets, absolute or relative to the page.
 *
 * The trailing slash is enforced rather than assumed, so `baseUrl: '/assets/solc'` does not quietly
 * resolve `soljson.js` as a sibling of `assets` instead of a child.
 */
function resolveBaseUrl(value) {
	let url;
	try {
		url = new URL(value, globalThis.location?.href);
	} catch (error) {
		throw new Error(
			`baseUrl must be an absolute http(s) URL, or relative to the page in a browser: ${error.message}`,
			{ cause: error }
		);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(
			`baseUrl must be an absolute http(s) URL, or relative to the page in a browser: got ${value}`
		);
	}
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url.href;
}

/** Check the compiler against the pinned receipt before anything executes it. */
export async function verifySoljson(bytes, label = SOLJSON) {
	const receipt = ASSET_RECEIPTS[SOLJSON];
	if (bytes.byteLength !== receipt.bytes) {
		throw new Error(`${label} is ${bytes.byteLength} bytes, expected ${receipt.bytes}`);
	}
	const digest = await sha256Hex(bytes);
	if (digest !== receipt.sha256) {
		throw new Error(
			`${label} failed SHA-256 verification: expected ${receipt.sha256}, got ${digest}. The ` +
				'compiler on that host is not the one this package was built and tested against.'
		);
	}
	return bytes;
}

export async function sha256Hex(bytes) {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new Error(
			'Verifying soljson.js needs crypto.subtle: a secure context in the browser, or Node 20 and ' +
				'later.'
		);
	}
	const digest = await subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
