// The compile-only bundle: `self.solcWasmToolchain`.
//
// A worker whose job is to compile and nothing else loads this rather than the full language bundle,
// because the EVM is a few hundred KB of JavaScript the compiler never touches. It is what the browser
// entry point's own worker loads.
import { resolveAssetSource } from './assets.js';
import { createInlineHost } from './host.inline.js';

/**
 * @param {object} [options]
 * @param {string} options.baseUrl - where soljson.js is served from.
 * @param {(value: number) => void} [options.progress]
 */
export async function createToolchain({ baseUrl, progress } = {}) {
	const source = resolveAssetSource({ baseUrl }, null);
	return createInlineHost({ source, progress });
}

/**
 * Load the compiler and then answer the message protocol the worker client speaks.
 *
 * The compiler is loaded eagerly rather than on the first message, so a caller awaiting `createCompiler`
 * is waiting for the download and not for a message that would never come without one.
 */
export function serve({ baseUrl } = {}) {
	const ready = createToolchain({
		baseUrl,
		progress: (value) => self.postMessage({ type: 'progress', value })
	}).then(
		(toolchain) => {
			self.postMessage({ type: 'ready', version: toolchain.version });
			return toolchain;
		},
		(error) => {
			self.postMessage({ type: 'error', message: messageOf(error) });
			throw error;
		}
	);
	// The client is told; do not also report it unhandled.
	ready.catch(() => undefined);

	self.onmessage = async (event) => {
		const { id, input } = event.data ?? {};
		try {
			const toolchain = await ready;
			self.postMessage({ id, ok: true, output: await toolchain.compile(input) });
		} catch (error) {
			self.postMessage({ id, ok: false, error: messageOf(error) });
		}
	};
}

export const messageOf = (error) => `${(error && error.message) || error}`;
