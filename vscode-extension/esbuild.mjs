// Bundle the extension for the VS Code extension host (Node, CommonJS entry).
// `vscode` is provided by the host and must stay external; `ws` is bundled.
import { build, context } from 'esbuild';
const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const c = await context(opts);
  await c.watch();
} else {
  await build(opts);
}
