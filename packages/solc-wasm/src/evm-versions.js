// The `evmVersion` axis: which EVM dialect the source is compiled for.
//
// This is this package's counterpart to clang-wasm's `std`. Both answer "which dialect should the
// compiler emit for", both are per-run overridable, and both have a discoverable list so a caller can
// build a picker without knowing the compiler's vocabulary.
//
// The list is not guessed from documentation: it is what solc 0.8.37 accepts, checked by compiling a
// trivial contract at each value. `amsterdam` is deliberately absent - solc accepts the name only
// when `settings.experimental` is on, so it is not reachable through this package's options.
// Everything up to `london` also makes solc emit its "EVM versions older than london is deprecated"
// warning; that is solc talking, and it is passed through rather than hidden.

export const EVM_VERSIONS = Object.freeze([
	'homestead',
	'tangerineWhistle',
	'spuriousDragon',
	'byzantium',
	'constantinople',
	'petersburg',
	'istanbul',
	'berlin',
	'london',
	'paris',
	'shanghai',
	'cancun',
	'prague',
	'osaka'
]);

export const DEFAULT_EVM_VERSION = 'cancun';

/** Every `evmVersion` this package accepts, for building a picker. */
export const evmVersionsFor = () => [...EVM_VERSIONS];

/**
 * There is deliberately no "null means let solc decide" escape hatch, which is where this differs from
 * clang-wasm's `std`. The `evmVersion` has to be known because the EVM side is configured from it: an
 * unknown value would mean picking a hardfork by guess, and picking one older than the bytecode needs
 * is exactly the failure this pairing exists to prevent.
 */
export function resolveEvmVersion(value) {
	if (value === undefined) return DEFAULT_EVM_VERSION;
	if (EVM_VERSIONS.includes(value)) return value;
	throw new Error(
		`evmVersion must be one of ${EVM_VERSIONS.join(', ')}, got ${JSON.stringify(value)}`
	);
}

/**
 * The `@ethereumjs` hardfork that executes bytecode compiled for an `evmVersion`.
 *
 * The two vocabularies are the same words with different casing for every value solc accepts -
 * `spuriousDragon` here is `SpuriousDragon` there, `cancun` is `Cancun` - so the mapping is the
 * capitalisation, and it is asserted in the tests rather than assumed.
 *
 * This pairing is load-bearing, not cosmetic: compiling for `cancun` and executing at `paris` means an
 * opcode like `MCOPY` is emitted by the compiler and then rejected by the VM, which surfaces as an
 * invalid-opcode failure on source that is perfectly valid.
 */
export const hardforkFor = (evmVersion) =>
	evmVersion.charAt(0).toUpperCase() + evmVersion.slice(1);
