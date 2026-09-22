// Node, where the compiler is a module rather than a URL.
//
// The copy of soljson.js this runs is the one the `solc` dependency installs - the same bytes
// `copy-assets` hands to a browser, which is what keeps the two environments running one compiler
// rather than two. It is not hashed here: Node parses 9.2 MB on import already, and hashing it again on
// every `createCompiler` would double that for a file the package manager already integrity-checked.
// The test suite pins it instead, against the same receipt the browser path enforces at runtime.
//
// `solc` is imported lazily so a process that never compiles anything never pays for the parse.
export async function createNodeHost() {
	const { default: solc } = await import('solc');
	return {
		version: solc.version(),
		compile: async (input) => JSON.parse(solc.compile(JSON.stringify(input))),
		dispose() {}
	};
}
