// ShapeShift - unit tests for the deterministic core (hash, KDF, PRNG, config).
// Usage: node scripts/test.mjs
//
// The extension's central contract is "same (salt, origin, config) -> same
// spoofed values". Nothing verified that contract before, so a change to the
// hash, the KDF loop or the PRNG seeding could silently break per-origin
// stability and every page would just get a new fingerprint on every load.
// These tests load the real core files and pin that behaviour.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
let checks = 0;

function ok (label) { checks++; console.log('  ok   ' + label); }
function fail (label, detail) { failures++; checks++; console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); }
function assert (label, condition, detail) {
  if (condition) ok(label); else fail(label, detail);
}
function section (name) { console.log(''); console.log(name); }

// Load a core file into an isolated sandbox object that plays the role of
// globalThis. The files are plain IIFEs that publish onto globalThis. Pass an
// existing sandbox to stack files that depend on each other (config-schema.js
// must be loaded before core/config.js, exactly as manifest.json orders them).
function loadCore (relPath, sandbox) {
  const target = sandbox || {};
  const code = readFileSync(join(ROOT, relPath), 'utf8');
  new Function('globalThis', 'chrome', code)(target, undefined);
  return target;
}

const hash = loadCore('core/hash.js');
const prng = loadCore('core/prng.js');
const config = loadCore('core/config-schema.js');
loadCore('core/config.js', config);

section('hash.js');
assert('ssHashString is exported', typeof hash.ssHashString === 'function');
assert('ssDeriveSeed is exported', typeof hash.ssDeriveSeed === 'function');
assert('ssDeriveStrongSeed is exported', typeof hash.ssDeriveStrongSeed === 'function');

const h1 = hash.ssHashString('shapeshift');
assert('hash is deterministic', h1 === hash.ssHashString('shapeshift'), h1 + ' vs ' + hash.ssHashString('shapeshift'));
assert('hash is a uint32', Number.isInteger(h1) && h1 >= 0 && h1 <= 0xFFFFFFFF, String(h1));
assert('hash separates inputs', h1 !== hash.ssHashString('shapeshifu'));
assert('hash is stable for empty input', hash.ssHashString('') === 0x811C9DC5, String(hash.ssHashString('')));

section('key derivation');
const salt = 'unit-test-salt';
const originA = 'https://a.example';
const originB = 'https://b.example';
const strongA1 = hash.ssDeriveStrongSeed(salt, originA, 1000);
const strongA2 = hash.ssDeriveStrongSeed(salt, originA, 1000);
assert('strong KDF is deterministic', strongA1 === strongA2, strongA1 + ' vs ' + strongA2);
assert('strong KDF separates origins', strongA1 !== hash.ssDeriveStrongSeed(salt, originB, 1000));
assert('strong KDF separates salts', strongA1 !== hash.ssDeriveStrongSeed(salt + 'x', originA, 1000));
assert('strong KDF respects iteration count', strongA1 !== hash.ssDeriveStrongSeed(salt, originA, 999));
const simple1 = hash.ssDeriveSeedSimple(salt, originA);
assert('simple derivation is deterministic', simple1 === hash.ssDeriveSeedSimple(salt, originA));
assert('simple derivation separates origins', simple1 !== hash.ssDeriveSeedSimple(salt, originB));

// P1 2.26: each surface gets its own seed stream so toggling one module cannot
// shift the values another module reports.
assert('ssDeriveSurfaceSeed is exported', typeof hash.ssDeriveSurfaceSeed === 'function');
const surf1 = hash.ssDeriveSurfaceSeed(salt, originA, 'canvas');
assert('surface seed is deterministic', surf1 === hash.ssDeriveSurfaceSeed(salt, originA, 'canvas'), String(surf1));
assert('surface seed is a uint32', Number.isInteger(surf1) && surf1 >= 0 && surf1 <= 0xFFFFFFFF, String(surf1));
assert('surface seed separates surfaces', surf1 !== hash.ssDeriveSurfaceSeed(salt, originA, 'fonts'));
assert('surface seed separates origins', surf1 !== hash.ssDeriveSurfaceSeed(salt, originB, 'canvas'));
assert('surface seed separates salts', surf1 !== hash.ssDeriveSurfaceSeed(salt + 'x', originA, 'canvas'));

section('prng.js');
assert('ssCreatePRNG is exported', typeof prng.ssCreatePRNG === 'function');
const seqA = [];
const seqB = [];
const genA = prng.ssCreatePRNG(123456);
const genB = prng.ssCreatePRNG(123456);
for (let i = 0; i < 64; i++) { seqA.push(genA()); seqB.push(genB()); }
assert('PRNG is deterministic for a seed', seqA.join(',') === seqB.join(','));
assert('PRNG stays in [0,1)', seqA.every((v) => v >= 0 && v < 1));
assert('PRNG is not constant', new Set(seqA).size > 60, String(new Set(seqA).size));
const other = prng.ssCreatePRNG(123457);
assert('PRNG separates seeds', other() !== seqA[0]);

section('config.js normalization');
assert('ssConfigSchema is exported', typeof config.ssConfigSchema === 'object');
assert('ssNormalizeConfig is exported', typeof config.ssNormalizeConfig === 'function');
const normalized = config.ssNormalizeConfig({ fuzzDeviceMemory: false, noiseLevel: 0.5, canvasNoiseStrength: 4 });
assert('flat key folds into its nested group', normalized.navigator && normalized.navigator.fuzzDeviceMemory === false, JSON.stringify(normalized.navigator));
assert('sibling group keys survive the fold', normalized.navigator.fuzzHardwareConcurrency === true, JSON.stringify(normalized.navigator));
assert('second flat key folds into its own group', normalized.geolocation && normalized.geolocation.noiseLevel === 0.5, JSON.stringify(normalized.geolocation));
assert('plain keys pass through untouched', normalized.canvasNoiseStrength === 4);
const empty = config.ssNormalizeConfig(null);
assert('normalization tolerates null', empty && typeof empty === 'object' && Object.keys(empty).length === 0);

section('defaults alignment');
// The ISOLATED hooks, the MAIN-world injector and the options UI each used to
// carry their own copy of these numbers; a drifted default meant two different
// protection levels for the same page. Pin the shared values here.
assert('canvasNoiseStrength default is 2', config.ssConfig.canvasNoiseStrength === 2, String(config.ssConfig.canvasNoiseStrength));
assert('webglJitter default is 2', config.ssConfig.webglJitter === 2, String(config.ssConfig.webglJitter));
assert('audioNoiseStrength default is 1e-7', config.ssConfig.audioNoiseStrength === 1e-7, String(config.ssConfig.audioNoiseStrength));

const canvasSrc = readFileSync(join(ROOT, 'content/hooks_canvas.js'), 'utf8');
const injectorSrc = readFileSync(join(ROOT, 'content/page_world_injector.js'), 'utf8');
assert('ISOLATED canvas hook uses the shared default', canvasSrc.indexOf('canvasNoiseStrength ?? 2') !== -1);
assert('MAIN-world canvas hook uses the shared default', injectorSrc.indexOf('canvasNoiseStrength ?? 2') !== -1);

// P1 2.26 wiring: every surface hook must ask for its own stream.
const surfaceHooks = ['canvas', 'webgl', 'audio', 'screen', 'navigator', 'webrtc', 'fonts', 'timezone', 'sensors', 'touch', 'useragent', 'media', 'geolocation', 'detection'];
const bootstrapSrc = readFileSync(join(ROOT, 'content/bootstrap.js'), 'utf8');
assert('bootstrap exposes prngFor', bootstrapSrc.indexOf('prngFor') !== -1);
// canvas/audio derive their noise from a hash of the pixel/sample index and
// never draw from the PRNG, so there is no shared stream to decouple. Any hook
// that *does* consume randomness must ask for its own stream.
const missingStream = surfaceHooks.filter((id) => {
  const src = readFileSync(join(ROOT, 'content/hooks_' + id + '.js'), 'utf8');
  if (!/env\.prng\b/.test(src)) return false;
  return !src.includes("prngFor('" + id + "')");
});
assert('every surface hook requests its own stream', missingStream.length === 0, missingStream.join(', '));

section('MAIN-world PRNG parity');
// P1 2.23: the MAIN world cannot load core/prng.js, so Xoshiro128** is inlined
// in page_world_injector.js. Pin the copy against core so the two cannot drift.
const inlined = injectorSrc.match(/function createPRNG[\s\S]*?\n  \}/);
assert('MAIN-world injector inlines createPRNG', !!inlined);
if (inlined) {
  const factory = new Function(inlined[0] + '\nreturn createPRNG;')();
  const a = prng.ssCreatePRNG(0x1234ABCD);
  const b = factory(0x1234ABCD);
  let same = true;
  for (let i = 0; i < 64; i++) { if (a() !== b()) { same = false; break; } }
  assert('inlined PRNG matches core/prng.js', same);
}

console.log('');
console.log((failures === 0 ? 'PASS' : 'FAIL') + ' - ' + (checks - failures) + '/' + checks + ' tests passed');
process.exit(failures === 0 ? 0 : 1);
