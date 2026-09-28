/**
 * Minimal ESM resolver for `node --test` (see the `test` script in package.json).
 *
 * The app's source files use extensionless relative imports (`./adapter`) and the
 * `@/` alias, which Vite and TypeScript resolve but Node's native ESM loader does
 * not. This hook maps those specifiers to real files on disk, so the application
 * modules can be tested directly with zero extra dependencies.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const HAS_EXTENSION = /\.[cm]?[jt]sx?$/;
const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Repository root = one level above this file's directory. */
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

export async function resolve(specifier, context, nextResolve) {
  if (HAS_EXTENSION.test(specifier)) return nextResolve(specifier, context);

  let basePath = null;

  if (specifier.startsWith('@/')) {
    basePath = resolvePath(ROOT, 'src', specifier.slice(2));
  } else if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    (context.parentURL?.startsWith('file:') ?? false)
  ) {
    basePath = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
  }

  if (basePath !== null) {
    for (const candidate of CANDIDATES) {
      const target = basePath + candidate;
      if (existsSync(target)) return nextResolve(pathToFileURL(target).href, context);
    }
  }

  return nextResolve(specifier, context);
}
