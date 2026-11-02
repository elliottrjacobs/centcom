#!/usr/bin/env node
/** Bundles everything that runs in Node: the server, the CLI, and the Electron main + preload. */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  absWorkingDir: root,
  logLevel: 'warning',
  legalComments: 'none',
  define: { 'process.env.CENTCOM_VERSION': JSON.stringify(pkg.version) },
};

await Promise.all([
  build({ ...common, entryPoints: ['server/index.ts'], outfile: 'dist-server/index.cjs' }),
  build({ ...common, entryPoints: ['cli/centcom.ts'], outfile: 'dist-cli/centcom.cjs', banner: { js: '#!/usr/bin/env node' } }),
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', external: ['electron'] }),
]);

fs.chmodSync(path.join(root, 'dist-cli/centcom.cjs'), 0o755);
console.log('built dist-server, dist-cli, dist-electron');
