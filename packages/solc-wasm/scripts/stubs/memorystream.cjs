// Stands in for `memorystream` when the wrapper is bundled for a browser.
//
// The wrapper only constructs one inside `loadRemoteVersion`, which downloads a compiler over HTTP from
// Node - a path that cannot be reached in a browser and that this package never calls. The stub exists
// so the bundler has something to resolve, and throws if that assumption ever stops holding.
module.exports = class MemoryStream {
	constructor() {
		throw new Error('memorystream is only available in Node; loadRemoteVersion is not supported here');
	}
};
