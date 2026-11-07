// Bundles the main process and preload with esbuild into out/ and copies the window (src/ui), translations and icons.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const production = process.env.NODE_ENV !== 'development';
rmSync('out', { recursive: true, force: true });
mkdirSync('out', { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
  external: ['electron', 'electron-updater'],
};
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'out/main.cjs' });
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'out/preload.cjs' });
cpSync('src/ui', 'out/ui', { recursive: true });
cpSync('i18n', 'out/i18n', { recursive: true });
cpSync('assets/icons', 'out/icons', { recursive: true });
cpSync('../Website/logo.svg', 'out/ui/logo.svg');
console.log('Built to out/');
