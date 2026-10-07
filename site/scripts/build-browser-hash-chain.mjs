import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
      crypto: path.join(root, 'site/src/browser/crypto.mjs'),
      'node:crypto': path.join(root, 'site/src/browser/crypto.mjs'),
    },
    logLevel: 'silent',
  });
}
