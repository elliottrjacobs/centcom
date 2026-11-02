import { build } from 'esbuild';
import fs from 'node:fs/promises';
const out='ios/CENTCOM/Resources/Markdown';
await fs.mkdir(out,{recursive:true});
await build({entryPoints:['ios/MarkdownWeb/editor.ts'],outfile:`${out}/editor.js`,bundle:true,format:'iife',platform:'browser',minify:true,target:'safari17',legalComments:'eof'});
await fs.copyFile('ios/MarkdownWeb/index.html',`${out}/index.html`);
console.log('Built shared iOS Markdown editor');
