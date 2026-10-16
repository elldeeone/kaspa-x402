import { build } from 'esbuild';

await build({ entryPoints: [new URL('./entrypoint.mjs', import.meta.url).pathname],
  outfile: new URL('./dist/relay.mjs', import.meta.url).pathname,
  platform: 'node', target: 'node22', format: 'esm', bundle: true,
  // Keep the imported relay's CLI guard false inside the bundled entrypoint.
  define: { 'import.meta.url': JSON.stringify('file:///source/scripts/demo-pnn-relay.mjs') },
  banner: { js: "import { createRequire as bundleCreateRequire } from 'node:module'; const require = bundleCreateRequire(import.meta.url);" },
});
