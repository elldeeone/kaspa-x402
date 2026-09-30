import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildBrowserHashChain(outDir) {
  return build({
    absWorkingDir: root,
    entryPoints: ['site/src/browser/hash-chain.mjs'],
    outfile: path.join(outDir, 'assets/hash-chain-client.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    inject: [path.join(root, 'site/src/browser/buffer.mjs')],
    alias: {
      'node:crypto': path.join(root, 'site/src/browser/crypto.mjs'),
      '@kaspa-x402/core': path.join(root, 'packages/core/src/index.ts'),
      '@kaspa-x402/covenant': path.join(root, 'packages/covenant/src/index.ts'),
      '@kaspa-x402/client': path.join(root, 'packages/client/src/index.ts'),
    },
    logLevel: 'silent',
  });
}
