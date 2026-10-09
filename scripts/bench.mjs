// ShapeShift - hot-path benchmark harness.
// Usage: node scripts/bench.mjs
//
// The P1 3.4 audit found the Canvas and Audio hooks hashing a freshly built
// string per sample: a 1920x1080 getImageData() meant ~2 million concatenations
// plus ~30 million character folds on the main thread. The fix carries an FNV-1a
// prefix state forward with `fnvUpdate` and hashes only the varying digits.
//
// Nothing measured that fix, so a future edit could quietly reintroduce the
// per-sample string build and every gate would still pass. This harness pins the
// shape of the hot path: it runs both formulations over the same sample count
// and fails when the prefix-carrying one is no longer faster.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function loadCore (relPath, sandbox) {
  const target = sandbox || {};
  const code = readFileSync(join(ROOT, relPath), 'utf8');
  new Function('globalThis', 'chrome', code)(target, undefined);
  return target;
}

const hash = loadCore('core/hash.js');
const hashString = hash.ssHashString;
const fnvUpdate = hash.ssFnvUpdate;
const fnvInit = hash.ssFnvInit;

if (typeof hashString !== 'function' || typeof fnvUpdate !== 'function' || typeof fnvInit !== 'function') {
  console.error('FAIL - core/hash.js no longer exports ssHashString / ssFnvUpdate / ssFnvInit');
  process.exit(1);
}

// Sample budget: the number of pixels in a 1280x720 read, i.e. the real hot loop
// rather than a token loop that would be dominated by timer noise.
const SAMPLES = 1280 * 720;
const seed = 0x51ab1e7;
const noiseStrength = 2;

function bench (label, fn) {
  // One warm-up pass so the JIT has seen the loop before the clock starts.
  fn();
  const start = process.hrtime.bigint();
  const checksum = fn();
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;
  return { label, ms, checksum, perSample: (ms * 1e6) / SAMPLES };
}

// The retired formulation: build a fresh `${seed}:${index}` string per sample and
// hash it from the FNV offset every time.
function perSampleStringBuild () {
  let sum = 0;
  for (let i = 0; i < SAMPLES; i++) {
    sum += ((hashString(seed + ':' + i) / 4294967296) - 0.5) * noiseStrength;
  }
  return sum;
}

// The shipped formulation: fold the constant prefix once, then hash only the
// decimal digits of the index with the carried state.
function carriedPrefixState () {
  const prefix = seed + ':';
  const prefixState = fnvUpdate(fnvInit(), prefix);
  let sum = 0;
  for (let i = 0; i < SAMPLES; i++) {
    sum += ((fnvUpdate(prefixState, i) / 4294967296) - 0.5) * noiseStrength;
  }
  return sum;
}

const naive = bench('per-sample string build', perSampleStringBuild);
const carried = bench('carried prefix state', carriedPrefixState);

// The two formulations must agree bit for bit, otherwise the optimised path is
// not a faithful rewrite and the benchmark is comparing different work.
const sameResult = Math.abs(naive.checksum - carried.checksum) < 1e-6;
const speedup = naive.ms / carried.ms;

const fmt = (n) => n.toFixed(2);
console.log('');
console.log('canvas/audio noise hot path (' + SAMPLES.toLocaleString('en-US') + ' samples)');
console.log('  ' + naive.label.padEnd(26) + fmt(naive.ms).padStart(9) + ' ms   ' + fmt(naive.perSample).padStart(7) + ' ns/sample');
console.log('  ' + carried.label.padEnd(26) + fmt(carried.ms).padStart(9) + ' ms   ' + fmt(carried.perSample).padStart(7) + ' ns/sample');
console.log('  speedup: ' + fmt(speedup) + 'x');

let failures = 0;
if (!sameResult) {
  failures++;
  console.log('  FAIL both formulations must derive the same value');
} else {
  console.log('  ok   both formulations derive the same value');
}
if (speedup <= 1) {
  failures++;
  console.log('  FAIL the carried prefix state is no longer faster than rebuilding the string per sample');
} else {
  console.log('  ok   the carried prefix state is faster than rebuilding the string per sample');
}

console.log('');
console.log((failures === 0 ? 'PASS' : 'FAIL') + ' - benchmark completed');
process.exit(failures === 0 ? 0 : 1);
