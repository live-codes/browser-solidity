// Stands in for `follow-redirects` when the wrapper is bundled for a browser.
//
// Used in exactly one place - `loadRemoteVersion`, which fetches a compiler from
// binaries.soliditylang.org over Node's http/https. That host sends no CORS header anyway, so the path
// is doubly unreachable in a browser. The stub throws rather than silently doing nothing.
const unreachable = () => {
	throw new Error('follow-redirects is only available in Node; loadRemoteVersion is not supported here');
};

module.exports = {
	http: { get: unreachable, request: unreachable },
	https: { get: unreachable, request: unreachable }
};
