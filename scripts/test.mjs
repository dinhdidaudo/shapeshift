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

section('MAIN-world determinism');
// P1: the MAIN world used to inline a Xoshiro128** copy of core/prng.js and
// draw every spoofed value from that one stream. A stream advances once per
// read, so calling navigator.hardwareConcurrency twice returned two different
// numbers - a one-line oracle that the ISOLATED hooks, which hash the same
// (seed, field) pair, would not have shown. The injector now hashes
// (seed, surface, field) per read and holds no per-load RNG state at all, so
// the pinned property is the absence of a stream, not parity with core.
assert('MAIN-world injector no longer inlines createPRNG', injectorSrc.indexOf('function createPRNG') === -1);
assert('MAIN-world injector never draws from a streaming PRNG', !/\bprng\s*\(/.test(injectorSrc));
assert('MAIN-world injector hashes its per-read values',
  injectorSrc.includes("hashString(seed + ':screen:resolution')") &&
  injectorSrc.includes("hashString(seed + ':nav:cores')") &&
  injectorSrc.includes("hashString(seed + ':tz:' + offsetKey)"));

section('MAIN-world config sanitation');
// P1 2.14: sanitizeConfig() used to copy every boolean/number key out of a
// config group, so a forged `screen: { evil: 1e9 }` reached the hooks. These
// pins execute the real function extracted from the injector source, so the
// group whitelist cannot silently regress to a blind copy.
const sanitizeBlock = injectorSrc.match(/const CONFIG_BOUNDS[\s\S]*?function sanitizeConfig[\s\S]*?\n  \}/);
assert('injector sanitizeConfig is extractable', !!sanitizeBlock);
if (sanitizeBlock) {
  const sanitizeConfig = new Function(sanitizeBlock[0] + '\nreturn sanitizeConfig;')();
  const junk = sanitizeConfig({ screen: { evil: 1e9, useRealDistribution: false } });
  assert('unknown group keys are dropped', junk.screen && junk.screen.evil === undefined, JSON.stringify(junk.screen));
  assert('whitelisted group booleans survive', junk.screen.useRealDistribution === false);
  const clamped = sanitizeConfig({ geolocation: { noiseLevel: 1e9 } });
  assert('group numbers are clamped', clamped.geolocation.noiseLevel === 1, JSON.stringify(clamped.geolocation));
  assert('non-object input yields null', sanitizeConfig(null) === null && sanitizeConfig('x') === null);
  const scalar = sanitizeConfig({ rotationIntervalHours: 1e9, canvasNoiseStrength: -5 });
  assert('top-level bounds still clamp', scalar.rotationIntervalHours === 8760 && scalar.canvasNoiseStrength === 0, JSON.stringify(scalar));
}

section('hook determinism wiring');
// P1 2.1/2.2/2.3: a value the page can read twice must not change between the
// two reads. These pins exist because the WebGL vendor suffix, the media
// capability answers and the RTCRtp* codec order were each drawn from a
// streaming PRNG per call, which is a one-line detector for the shim.
const webglSrc = readFileSync(join(ROOT, 'content/hooks_webgl.js'), 'utf8');
const mediaSrc = readFileSync(join(ROOT, 'content/hooks_media.js'), 'utf8');
const fontsSrc = readFileSync(join(ROOT, 'content/hooks_fonts.js'), 'utf8');
const sensorsSrc = readFileSync(join(ROOT, 'content/hooks_sensors.js'), 'utf8');
// hooks_sensors.js deliberately quotes the removed patterns in its own comments
// ("returning a hard-coded [null, null, null, null] ...", "defineEmptyArrayLike()
// was dead code"), so the negative pins must read executable code only.
const sensorsCode = sensorsSrc.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10));
assert('ISOLATED webgl suffixes from a stable hash', webglSrc.includes('stableSuffix('));
assert('MAIN-world webgl suffixes from a stable hash', injectorSrc.includes("hashString(seed + ':webgl:'"));
assert('media capabilities use stableRoll', mediaSrc.includes('function stableRoll') && mediaSrc.includes("stableRoll('canplay'") && mediaSrc.includes("stableRoll('rtp-sender'"));
assert('media hooks never draw from the streaming PRNG', !/prng\(\)/.test(mediaSrc));
assert('font check only upgrades absence, never hides a real font', fontsSrc.includes('if (result === false && globalThis.ssHashString)'));
assert('gamepads are hidden with an iterable, not a null-filled array', sensorsCode.includes('return [];') && !sensorsCode.includes('[null, null, null, null]'));
assert('battery times follow the real charging flag', sensorsSrc.includes('realCharging ? 0 : Infinity') && sensorsSrc.includes('realDischargingTime'));
assert('dead plugin helper stayed deleted', !sensorsCode.includes('defineEmptyArrayLike'));

console.log('');
console.log((failures === 0 ? 'PASS' : 'FAIL') + ' - ' + (checks - failures) + '/' + checks + ' tests passed');
process.exit(failures === 0 ? 0 : 1);
