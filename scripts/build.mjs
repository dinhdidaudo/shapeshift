// ShapeShift - dependency-free packaging build.
// Usage: node scripts/build.mjs [--out dist]
//
// ShapeShift ships as plain JavaScript and is loaded unpacked, so the "build"
// is a curated copy of the runtime tree into dist/ (no bundler, no transform).
// The structural gate (scripts/verify.mjs) runs first and aborts on failure.
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const outArg = process.argv.indexOf('--out');
const OUT = join(ROOT, outArg !== -1 && process.argv[outArg + 1] ? process.argv[outArg + 1] : 'dist');

const RUNTIME = [
  'manifest.json',
  'background',
  'core',
  'content',
  'popup',
  'options',
  'images',
  '_locales'
];

const DOCS = ['README.md', 'LICENSE', 'CHANGELOG.md'];

function runGate () {
  console.log('Running verify gate...');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'verify.mjs')], { stdio: 'inherit' });
}

function main () {
  runGate();

  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

  for (const entry of RUNTIME) {
    const src = join(ROOT, entry);
    if (!existsSync(src)) {
      console.error(`missing required runtime path: ${entry}`);
      process.exit(1);
    }
    cpSync(src, join(OUT, entry), { recursive: true });
  }
  for (const doc of DOCS) {
    const src = join(ROOT, doc);
    if (existsSync(src)) cpSync(src, join(OUT, doc));
  }

  console.log(`\nBuilt ShapeShift ${manifest.version} -> ${OUT}`);
  console.log('Load it with chrome://extensions -> Developer mode -> Load unpacked.');
}

main();
