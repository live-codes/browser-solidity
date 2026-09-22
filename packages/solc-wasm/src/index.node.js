// Node, where the compiler is the installed `solc` package, so `baseUrl` is optional and
// `createCompiler()` is enough on its own.
import { createApi } from './api.js';
import { createNodeHost } from './host.node.js';
import { packagedAssets } from './packaged.node.js';

export { EVM_VERSIONS, evmVersionsFor } from './evm-versions.js';

const api = createApi({ packaged: packagedAssets, createHost: createNodeHost });

export const createCompiler = api.createCompiler;
