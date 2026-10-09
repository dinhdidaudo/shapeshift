// One-shot migration: rebrand the inherited engine namespace fp*/fp_* -> ss*/ss_*.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ROOT must come from fileURLToPath, not from `URL.pathname`: the pathname is
// percent-encoded, so a checkout under a path with a space ("C:/Users/My
// Name/...") yields a directory no fs call can open, and on Windows it also
// keeps the leading slash (`/D:/Dev/...`). fileURLToPath decodes and normalises
// it for the host platform. verify.mjs pins this form across scripts/.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'scripts', 'artifacts']);
const EXTS = new Set(['.js', '.ts', '.html', '.css', '.json', '.md']);

// Order matters: longer/more specific tokens first.
const REPLACEMENTS = [
  // storage keys
  ['fp_site_settings', 'ss_site_settings'],
  ['fp_rotation_info', 'ss_rotation_info'],
  ['fp_stats', 'ss_stats'],
  ['fp_salt', 'ss_salt'],
  // config object + globals (camelCase identifiers)
  ['fpConfig', 'ssConfig'],
  ['fpLoadConfig', 'ssLoadConfig'],
  ['fpGetSalt', 'ssGetSalt'],
  ['fpDeriveSeedSimple', 'ssDeriveSeedSimple'],
  ['fpDeriveStrongSeed', 'ssDeriveStrongSeed'],
  ['fpDeriveSeed', 'ssDeriveSeed'],
  ['fpHashString', 'ssHashString'],
  ['fpCreateMulberry32', 'ssCreateMulberry32'],
  ['fpCreatePRNG', 'ssCreatePRNG'],
  ['fpPRNG', 'ssPRNG'],
  ['fpNoise', 'ssNoise'],
  ['fpEnv', 'ssEnv'],
  ['fpReady', 'ssReady'],
  ['fpHookInstallers', 'ssHookInstallers'],
  ['fpTestFingerprint', 'ssTestFingerprint'],
  ['fpTestRequest', 'ssTestRequest'],
  ['fpTestResponse', 'ssTestResponse'],
  ['fpTimingUtils', 'ssTimingUtils'],
  ['fpStealth', 'ssStealth'],
  ['fpStatsTracker', 'ssStatsTracker'],
  ['fpMaskVendors', 'ssMaskVendors'],
  ['fpShuffleExt', 'ssShuffleExt'],
  ['fpJitter', 'ssJitter'],
  ['fpDebug', 'ssDebug'],
  ['fpSeed', 'ssSeed'],
  ['__fp_patched', '__ss_patched'],
  // message / event channel names
  ['FP_INIT_PAGE_HOOKS', 'SS_INIT_PAGE_HOOKS'],
  ['FP_STATS', 'SS_STATS'],
  ['FP Rotation', 'ShapeShift Rotation'],
  ['Fingerprint Shuffled', 'ShapeShift applied'],
  ['[fp]', '[shapeshift]'],
];

let touched = 0;
let changedTokens = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (!EXTS.has(extname(full))) continue;
    let text = readFileSync(full, 'utf8');
    const original = text;
    for (const [from, to] of REPLACEMENTS) {
      if (text.includes(from)) {
        const hits = text.split(from).length - 1;
        text = text.split(from).join(to);
        changedTokens += hits;
      }
    }
    if (text !== original) {
      writeFileSync(full, text, 'utf8');
      touched++;
      console.log('rewrote', full.slice(ROOT.length + 1));
    }
  }
}

walk(ROOT);
console.log(`\n${touched} files rewritten, ${changedTokens} token replacements.`);
