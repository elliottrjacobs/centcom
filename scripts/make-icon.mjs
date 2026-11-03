#!/usr/bin/env node
/**
 * Package the supplied glossy radar artwork without redrawing or recoloring it.
 * Source: build/centcom-logo.jpg. Run: node scripts/make-icon.mjs
 * Requires macOS sips/iconutil and rsvg-convert (brew install librsvg).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');
const source = path.join(out, 'centcom-logo.jpg');
const artwork = fs.readFileSync(source).toString('base64');

function png(relativePath, size) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), source, '--out', destination], { stdio: 'pipe' });
}

// iOS applies its own corner mask. Keep its source square and opaque.
png('ios/CENTCOM/Assets.xcassets/AppIcon.appiconset/Icon.png', 1024);
png('src/assets/centcom-logo.png', 256);
const logoSet = path.join(root, 'ios/CENTCOM/Assets.xcassets/CentcomLogo.imageset');
fs.mkdirSync(logoSet, { recursive: true });
fs.copyFileSync(path.join(root, 'src/assets/centcom-logo.png'), path.join(logoSet, 'Logo.png'));
fs.writeFileSync(path.join(logoSet, 'Contents.json'), JSON.stringify({
  images: [{ filename: 'Logo.png', idiom: 'universal' }],
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');
png('public/favicon-32.png', 32);
png('public/favicon-192.png', 192);
png('public/apple-touch-icon.png', 180);

// macOS needs its own rounded tile, inset to align with neighboring Dock icons.
// Embed the unchanged JPG so the SVG is self-contained and preserves the mark.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="#171819" filter="url(#shadow)"/>
  <image x="100" y="100" width="824" height="824" clip-path="url(#tile)" xlink:href="data:image/jpeg;base64,${artwork}"/>
</svg>\n`;
const svgPath = path.join(out, 'icon.svg');
fs.writeFileSync(svgPath, svg);
execFileSync('rsvg-convert', ['-w', '1024', '-h', '1024', svgPath, '-o', path.join(out, 'icon.png')]);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'centcom-icon-'));
try {
  const iconset = path.join(scratch, 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const factor of [1, 2]) {
      const px = String(size * factor);
      const name = `icon_${size}x${size}${factor === 2 ? '@2x' : ''}.png`;
      execFileSync('rsvg-convert', ['-w', px, '-h', px, svgPath, '-o', path.join(iconset, name)]);
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(out, 'icon.icns')]);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log('Updated Mac, iOS, web, and in-app branding from build/centcom-logo.jpg');
