/**
 * Registers the TypeScript resolver hook before the test files load.
 * Used by `npm test`; see scripts/ts-resolve-loader.mjs for details.
 */
import { register } from 'node:module';

register('./ts-resolve-loader.mjs', import.meta.url);
