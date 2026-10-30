import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFullDocument } from '../src/components/page';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(scriptDir, '..');
const repoRoot = resolve(siteRoot, '..');
const outDir = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(siteRoot, 'dist');
const assetsOut = join(outDir, 'assets');
const publicAssets = process.env.PUBLIC_ASSETS_DIR
  ? resolve(process.env.PUBLIC_ASSETS_DIR)
  : join(siteRoot, 'public', 'assets');

mkdirSync(assetsOut, { recursive: true });

if (existsSync(publicAssets)) {
  cpSync(publicAssets, assetsOut, { recursive: true });
}

// Fallback hydration from primary repository assets if missing in publicAssets
const repoFallbacks: Array<[string, string]> = [
  [join(repoRoot, 'mods/kachi/fx/kachi-0.wav'), join(assetsOut, 'audio/kachi-0.wav')],
  [join(repoRoot, 'mods/kachi/fx/kachi-1.wav'), join(assetsOut, 'audio/kachi-1.wav')],
  [join(repoRoot, 'mods/kachi/fx/kachi-2.wav'), join(assetsOut, 'audio/kachi-2.wav')],
  [join(repoRoot, 'mods/kachi/fx/kachi-3.wav'), join(assetsOut, 'audio/kachi-3.wav')],
  [join(repoRoot, 'artifacts/promo/final-promo.mp4'), join(assetsOut, 'video/final-promo.mp4')],
  [join(repoRoot, 'artifacts/promo/assets/fonts/FiraCode-Regular.ttf'), join(assetsOut, 'fonts/FiraCode-Regular.ttf')],
  [join(repoRoot, 'artifacts/promo/assets/fonts/FiraCode-SemiBold.ttf'), join(assetsOut, 'fonts/FiraCode-SemiBold.ttf')],
];

for (const [src, dest] of repoFallbacks) {
  if (!existsSync(dest) && existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}

const css = readFileSync(join(siteRoot, 'src', 'styles', 'main.css'), 'utf8');
writeFileSync(join(assetsOut, 'main.css'), css, 'utf8');

const buildResult = await Bun.build({
  entrypoints: [join(siteRoot, 'src', 'client.ts')],
  outdir: assetsOut,
  minify: true,
  format: 'iife',
  target: 'browser',
  naming: 'client.js',
});

if (!buildResult.success) {
  console.error('Client bundle failed:', buildResult.logs);
  process.exit(1);
}

const html = renderFullDocument();
writeFileSync(join(outDir, 'index.html'), html, 'utf8');

const requiredAssets = [
  'images/obsidian-instrument.webp',
  'images/tri-engine-prism.webp',
  'images/kachi-refraction.webp',
  'images/promo-poster.webp',
  'images/promo-preview.webp',
  'images/og-card.jpg',
  'audio/kachi-0.wav',
  'audio/kachi-1.wav',
  'audio/kachi-2.wav',
  'audio/kachi-3.wav',
  'fonts/FiraCode-Regular.ttf',
  'fonts/FiraCode-SemiBold.ttf',
  'video/final-promo.mp4',
  'main.css',
  'client.js',
];

const missing = requiredAssets.filter((rel) => !existsSync(join(assetsOut, rel)));
if (missing.length > 0) {
  console.error('Missing required build assets:', missing);
  process.exit(1);
}

console.log(`Built claude-mods LP -> ${outDir} (all ${requiredAssets.length} assets verified)`);
