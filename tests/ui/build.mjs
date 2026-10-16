/* 用 esbuild 把三个挂载入口打包成 CJS，供 ui-regression.cjs 在 jsdom 中 require。
 * 产物写到 tests/ui/.build/（gitignored）。运行：`npm run test:ui`。 */
import { build } from 'esbuild';

const TARGETS = [
  ['mount-settings.jsx', '.build/mount-settings.cjs'],
  ['mount-ai.jsx', '.build/mount-ai.cjs'],
  ['mount-cards.jsx', '.build/mount-cards.cjs'],
];

await Promise.all(TARGETS.map(([infile, outfile]) => build({
  entryPoints: ['tests/ui/' + infile],
  outfile: 'tests/ui/' + outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  loader: { '.jsx': 'jsx' },
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
})));

console.log('ui test bundles built →', TARGETS.map(([, o]) => o).join(', '));
