// The solc standard-JSON request, and the reading of its reply.
//
// Everything here is environment-free: the same functions serve the Node host and the worker host, so
// the browser and Node cannot drift in what they ask the compiler for or in how they read the answer.

/**
 * What solc is asked for. `deployedBytecode` is requested purely so a caller can report the runtime
 * size; nothing in this package executes it.
 */
export function buildInput({ code, fileName, evmVersion }) {
	return {
		language: 'Solidity',
		sources: { [fileName]: { content: code } },
		settings: {
			evmVersion,
			outputSelection: {
				'*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] }
			}
		}
	};
}

/**
 * solc reports a failed compilation in the reply rather than by throwing - `compile()` only throws when
 * it cannot be called at all - so every caller has to look for `severity === 'error'` before it dares
 * execute anything. That asymmetry is the whole reason this function exists.
 *
 * Errors and warnings are kept apart, which is a deliberate difference from clang-wasm where the one
 * `errors` array holds whatever the compiler said. Solidity warns a lot on code that is perfectly fine
 * - a missing SPDX identifier, an `evmVersion` older than `london`, an unused local - and a caller that
 * treats every diagnostic as fatal would refuse to run most of what users type. So `errors` is the
 * failure signal and `warnings` is separate; `lines` is both, for display.
 *
 * @returns {{lines: string[], errors: string[], warnings: string[], hasError: boolean}}
 */
export function collectDiagnostics(output) {
	const lines = [];
	const errors = [];
	const warnings = [];
	let hasError = false;
	for (const entry of output.errors ?? []) {
		const text = `${entry.formattedMessage ?? entry.message}`.trimEnd();
		lines.push(text);
		if (entry.severity === 'error') {
			hasError = true;
			errors.push(text);
		} else {
			warnings.push(text);
		}
	}
	return { lines, errors, warnings, hasError };
}

/**
 * The contracts solc produced, keyed by name, with `0x`-prefixed bytecode.
 *
 * solc returns bytecode without the prefix and uses the empty string for abstract contracts and
 * interfaces, which cannot be deployed; both are normalised here so nothing downstream has to know.
 */
export function collectContracts(output, fileName) {
	const byFile = output.contracts?.[fileName] ?? {};
	const contracts = {};
	for (const [name, contract] of Object.entries(byFile)) {
		const bytecode = contract.evm?.bytecode?.object ?? '';
		contracts[name] = {
			name,
			abi: contract.abi ?? [],
			bytecode: bytecode ? `0x${bytecode}` : '',
			deployedBytecode: contract.evm?.deployedBytecode?.object
				? `0x${contract.evm.deployedBytecode.object}`
				: ''
		};
	}
	return contracts;
}
