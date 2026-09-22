// Stands in for Node's `assert` when the wrapper is bundled for a browser.
//
// `solc/wrapper.js` and the bindings under it require `assert` and call it as a function -
// `(0, assert_1.default)(condition, message)` - so the replacement has to be callable and carry the
// methods they reach for. Only the argument checks on the paths this package uses ever run; the module
// is not a test framework and is not trying to be one.
//
// Written as CommonJS on purpose: `__importDefault` only unwraps a real `default` when `__esModule` is
// set, and `module.exports = fn` is what makes `assert_1.default` the function itself.
function assert(value, message) {
	if (!value) assert.fail(message);
}

assert.ok = assert;

assert.fail = (message) => {
	throw new assert.AssertionError({ message });
};

assert.equal = (actual, expected, message) => {
	// eslint-disable-next-line eqeqeq
	if (actual != expected) assert.fail(message ?? `${actual} != ${expected}`);
};

assert.strictEqual = (actual, expected, message) => {
	if (actual !== expected) assert.fail(message ?? `${actual} !== ${expected}`);
};

assert.notStrictEqual = (actual, expected, message) => {
	if (actual === expected) assert.fail(message ?? `${actual} === ${expected}`);
};

assert.deepStrictEqual = assert.strictEqual;

assert.AssertionError = class AssertionError extends Error {
	constructor(options = {}) {
		super(options.message);
		this.name = 'AssertionError';
	}
};

module.exports = assert;
