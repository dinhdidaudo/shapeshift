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
import { createContext, runInContext } from 'node:vm';

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

// P1 (KDF collisions): the retired derivation concatenated its fields with no
// separator, so ("ab","c") and ("a","bc") flattened onto one byte stream, and a
// numeric counter could be absorbed by the salt (i=1 with salt "2" produced the
// same input as i=12 with an empty tail). Both properties are invisible in a
// same-input/same-output check, so pin them directly.
assert('ssMixString is exported', typeof hash.ssMixString === 'function');
assert('KDF field folding cannot collide',
  hash.ssMixString('ab', 'c') !== hash.ssMixString('a', 'bc'),
  'two different tuples produced the same derived value');
assert('KDF counter cannot be absorbed by the salt',
  hash.ssMixString('seed', '2', 1) !== hash.ssMixString('seed', '', 12),
  'a numeric counter was absorbed into the preceding field');
// The legacy path used to XOR the two FNV folds, which made it order-insensitive
// (deriveSeed(A,B) === deriveSeed(B,A)) - a real collision, since the two
// arguments mean different things (salt vs origin).
assert('simple derivation is order-sensitive',
  hash.ssDeriveSeedSimple(salt, originA) !== hash.ssDeriveSeedSimple(originA, salt),
  'legacy derivation is still order-insensitive');
// A config typo used to reach the derivation loop verbatim, so a negative or
// non-finite `kdfIterations` either hung the page or collapsed the KDF.
assert('ssClampIterations is exported', typeof hash.ssClampIterations === 'function');
assert('KDF iteration count is clamped',
  hash.ssClampIterations(-5, 1000) === 1000 &&
  hash.ssClampIterations(NaN, 1000) === 1000 &&
  hash.ssClampIterations(0, 1000) === 1000 &&
  hash.ssClampIterations(1e9, 1000) === 200000 &&
  hash.ssClampIterations(3.7, 1000) === 3,
  'kdfIterations is not clamped against the fallback/ceiling');

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
// P1 (hot loop): the ISOLATED canvas hook folds the constant `<seed>:` prefix
// once and carries the FNV state into each byte; the MAIN copy re-hashed the
// whole string per byte. That is the same bug at the same call site in the
// other world, so the MAIN injector must expose the same prefix-carrying fold
// (an inline fnvUpdate) and must derive its per-byte noise from the carried
// state rather than rebuilding `canvasSeed + ':' + index`.
assert('MAIN-world canvas noise carries the FNV prefix state',
  injectorSrc.includes('function fnvUpdate(state, value)') &&
  injectorSrc.includes("fnvUpdate(FNV_OFFSET, canvasSeed + ':')") &&
  injectorSrc.includes('fnvUpdate(canvasPrefixState, index)') &&
  !injectorSrc.includes("hashString(canvasSeed + ':' + index)"),
  'the MAIN canvas hook still rebuilds a string per byte');
// P1 4.4 (two-world divergence): both timezone copies probe the real zone's
// offset on two dates to build the DST-consistent candidate set. Those probes
// used `new Date()` / `Date.now() + 182d`, so the set - and therefore the zone
// the seed picked out of it - changed with the season, and the two worlds could
// straddle a DST boundary and pick from different sets on the same load. Both
// must probe the same two FIXED instants and key the pick on ':tz:'.
const tzSrc = readFileSync(join(ROOT, 'content/hooks_timezone.js'), 'utf8');
assert('both worlds probe the timezone DST set on fixed instants',
  tzSrc.includes('Date.UTC(2024, 0, 15, 12, 0, 0)') &&
  tzSrc.includes('Date.UTC(2024, 6, 15, 12, 0, 0)') &&
  injectorSrc.includes('Date.UTC(2024, 0, 15, 12, 0, 0)') &&
  injectorSrc.includes('Date.UTC(2024, 6, 15, 12, 0, 0)'),
  'the two worlds probe different DST instants for the timezone candidate set');
assert('neither world probes the timezone set with the wall clock',
  !/zoneOffsetMinutes\([^)]*new Date\(\)/.test(tzSrc) &&
  !/zoneOffsetMinutes\([^)]*new Date\(\)/.test(injectorSrc),
  'a timezone DST probe still reads the wall clock');
assert('both worlds pick the timezone on the shared :tz: key',
  tzSrc.includes("':tz:' + offsetKey") &&
  injectorSrc.includes("hashString(seed + ':tz:' + offsetKey)"),
  'the two worlds derive different timezone picks');
assert('both worlds compare BOTH DST probes when filtering zones',
  tzSrc.includes('zoneOffsetMinutes(z, sampleA) === realA') &&
  tzSrc.includes('zoneOffsetMinutes(z, sampleB) === realB') &&
  injectorSrc.includes('zoneOffsetMinutes(z, sampleA) === realA') &&
  injectorSrc.includes('zoneOffsetMinutes(z, sampleB) === realB'),
  'one world filters the candidate set on a single probe');
assert('the timezone hook keeps the real getTimezoneOffset',
  !/getTimezoneOffset\s*=\s*function/.test(tzSrc) && !/getTimezoneOffset\s*=/.test(tzSrc.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10))),
  'hooks_timezone.js overrides getTimezoneOffset');
assert('MAIN-world keeps the real getTimezoneOffset too',
  !/getTimezoneOffset\s*=/.test(injectorSrc.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//') && !l.includes('[shapeshift]')).join(String.fromCharCode(10))),
  'page_world_injector.js overrides getTimezoneOffset');
// P1 3.1 (static surface): both worlds replace Intl.DateTimeFormat with a
// wrapper that only rewrites resolvedOptions().timeZone, then restore the
// static surface (supportedLocalesOf, formatRange, ...) and the prototype
// chain. Restoring it with different spellings left the own-property list a
// page reads off Intl.DateTimeFormat.prototype different between the two
// realms - itself a one-line world-split oracle. Pin the identical two-line
// spelling in both files.
assert('both worlds restore the Intl.DateTimeFormat prototype identically',
  tzSrc.includes('Object.setPrototypeOf(Intl.DateTimeFormat, OrigDateTimeFormat)') &&
  tzSrc.includes('Intl.DateTimeFormat.prototype = OrigDateTimeFormat.prototype') &&
  injectorSrc.includes('Object.setPrototypeOf(Intl.DateTimeFormat, OrigIntlDateTimeFormat)') &&
  injectorSrc.includes('Intl.DateTimeFormat.prototype = OrigIntlDateTimeFormat.prototype'),
  'the two worlds restore the Intl.DateTimeFormat static surface differently');
assert('neither world rebuilds Intl.DateTimeFormat.prototype as a synthetic object',
  !/Intl\.DateTimeFormat\.prototype\s*=\s*\{/.test(tzSrc) &&
  !/Intl\.DateTimeFormat\.prototype\s*=\s*\{/.test(injectorSrc) &&
  !/Intl\.DateTimeFormat\.prototype\s*=\s*Object\.create/.test(tzSrc) &&
  !/Intl\.DateTimeFormat\.prototype\s*=\s*Object\.create/.test(injectorSrc),
  'Intl.DateTimeFormat.prototype was replaced with a synthetic object');

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
// enumerateDevices lives in hooks_webrtc.js, not hooks_media.js - the earlier
// pins read the wrong file and could never have caught a cross-world mismatch.
const webrtcSrc = readFileSync(join(ROOT, 'content/hooks_webrtc.js'), 'utf8');
// hooks_sensors.js deliberately quotes the removed patterns in its own comments
// ("returning a hard-coded [null, null, null, null] ...", "defineEmptyArrayLike()
// was dead code"), so the negative pins must read executable code only.
const sensorsCode = sensorsSrc.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10));
// Both worlds must key every derived WebGL value on (seed, param, value) with
// the SAME surface tag, or the two worlds report different vendor strings and
// numbers for the same context - which is itself a fingerprint.
assert('ISOLATED webgl numeric jitter keys on (seed, param, value)',
  webglSrc.includes("hashString(key)") && webglSrc.includes("':wgl:' + p + ':' + value"),
  'no :wgl: keyed jitter in hooks_webgl.js');
assert('MAIN-world webgl numeric jitter keys on (seed, param, value)',
  injectorSrc.includes("hashString(seed + ':wgl:' + p + ':' + value)"),
  'no :wgl: keyed jitter in page_world_injector.js');
assert('both worlds pick the same GPU persona from the seed',
  webglSrc.includes("':gpu'") && injectorSrc.includes("hashString(seed + ':gpu')"));
// P2 (world split, audit 3.2): getShaderPrecisionFormat's `precision` shift was
// applied in MAIN only, so the ISOLATED copy - the one test_fingerprint.js
// samples - reported the real GPU triple while the page saw a shifted one.
// Both must key the same shift on the same ':wglprec:' tuple.
assert('both worlds shift getShaderPrecisionFormat precision',
  webglSrc.includes("':wglprec:' + shaderType + ':' + precisionType") &&
  injectorSrc.includes("':wglprec:' + shaderType + ':' + precisionType"),
  'the two worlds disagree on the shader precision shift');
assert('ISOLATED getShaderPrecisionFormat returns the native prototype',
  webglSrc.includes('Object.create(Object.getPrototypeOf(real))'),
  'the ISOLATED precision triple is not shaped like the native one');
// P1 (world split, audit 3.2): the two copies of the GPU persona table are the
// single most dangerous duplicate in the tree. They were previously compared
// only by "contains os: 'windows'", which passes even if the entries, their
// order, or their index-to-GPU mapping differ - and index i of the filtered
// list IS the shared ':gpu' key, so a reordered or edited entry makes the MAIN
// world name one GPU while the ISOLATED world names another for the same seed.
// Extract both array literals and compare them token-for-token.
function extractArrayLiteral (src, name) {
  const at = src.indexOf('const ' + name + ' = [');
  if (at < 0) return null;
  const open = src.indexOf('[', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}
const normLiteral = (s) => (s === null ? null : s.replace(/\s+/g, ' ').trim());
const mainPersonas = normLiteral(extractArrayLiteral(injectorSrc, 'GPU_PERSONAS_ALL'));
const isoPersonas = normLiteral(extractArrayLiteral(webglSrc, 'GPU_PERSONAS_ALL'));
assert('both worlds hold a byte-identical GPU persona table',
  mainPersonas !== null && mainPersonas === isoPersonas,
  'GPU_PERSONAS_ALL diverged between the two worlds');
// The numeric offset formula has to be arithmetically identical in both worlds.
// A divergent scale (e.g. one world using jitter/2) is invisible to a
// `':wgl:'` substring check but makes one page read two different values.
assert('both worlds use the same webgl offset arithmetic',
  injectorSrc.includes('% 1000) / 1000 - 0.5) * jitter') &&
  webglSrc.includes('% 1000) / 1000) - 0.5) * jitter'),
  'the two worlds perturb numeric params with different arithmetic');
assert('both worlds derive jitter from the same default',
  injectorSrc.includes('config.webglJitter ?? 2') && webglSrc.includes('config.webglJitter ?? 2'),
  'webglJitter falls back to a different value in one world');
// Same shift rule for the precision triple: `% 2) === 1` then `precision - 1`.
assert('both worlds apply the same shader precision shift',
  /% 2\) === 1[\s\S]{0,120}real\.precision - 1/.test(injectorSrc) &&
  /% 2\) === 1[\s\S]{0,120}real\.precision - 1/.test(webglSrc),
  'the two worlds shift precision by different rules');
// The extension-marker pins above only inspect the vendor strings. The hardware
// limit set is the other half of the P0 regression: if MAIN and the ISOLATED
// copy disagree about which enums are exact, one world returns 16386 for
// MAX_TEXTURE_SIZE while the other returns 16384.
const mainLimits = normLiteral(extractArrayLiteral(injectorSrc.replace('new Set([', 'const INTEGER_LIMIT_PARAMS = ['), 'INTEGER_LIMIT_PARAMS'));
const isoLimits = normLiteral(extractArrayLiteral(webglSrc.replace('new Set([', 'const INTEGER_LIMIT_PARAMS = ['), 'INTEGER_LIMIT_PARAMS'));
assert('both worlds pin the same integer hardware-limit enums',
  mainLimits !== null && mainLimits === isoLimits,
  'INTEGER_LIMIT_PARAMS diverged between the two worlds');
// P2 (world split, audit 4.2/4.3): MAIN computed `max(2, base + hash%5 - 2)`
// while the ISOLATED copy used a +/-1 choice table and a truthy config test, so
// the same page read two different core counts - and an absent config key meant
// the fuzz was on in one world and off in the other. Both must now share the
// formula, the clamp and the `!== false` opt-out.
const navSrc = readFileSync(join(ROOT, 'content/hooks_navigator.js'), 'utf8');
assert('both worlds fuzz hardwareConcurrency with the same formula',
  navSrc.includes("':nav:cores') % 5) - 2") &&
  injectorSrc.includes("':nav:cores') % 5) - 2") &&
  navSrc.includes('Math.max(2, ') && injectorSrc.includes('Math.max(2, '),
  'the two worlds derive different hardwareConcurrency values');
assert('both worlds fuzz deviceMemory with the same formula',
  navSrc.includes("':nav:memory') % 5) - 2") &&
  injectorSrc.includes("':nav:memory') % 5) - 2") &&
  navSrc.includes('Math.max(4, ') && injectorSrc.includes('Math.max(4, '),
  'the two worlds derive different deviceMemory values');
assert('both worlds treat an absent navigator fuzz key as enabled',
  navSrc.includes('navCfg.fuzzHardwareConcurrency !== false') &&
  navSrc.includes('navCfg.fuzzDeviceMemory !== false') &&
  injectorSrc.includes('fuzzHardwareConcurrency !== false') &&
  injectorSrc.includes('fuzzDeviceMemory !== false'),
  'one world still reads an absent fuzz key as off');
// P1 4.2 (two-world divergence): hooks_useragent.js kept the REAL appVersion.
// The old `indexOf(realToken)` guard never matched (Chrome's appVersion carries
// no `Chrome/<v>` token), so this world answered with the native string while
// MAIN answered with the rebuilt one - one read, two machines. Both must derive
// appVersion from the same platform + ':uabuild' pair.
const uaSrc = readFileSync(join(ROOT, 'content/hooks_useragent.js'), 'utf8');
assert('both worlds rebuild appVersion from the shared uaBuild pair',
  uaSrc.includes("'5.0 (' + platformUa +") &&
  injectorSrc.includes("uaGet().replace('Mozilla/', '')"),
  'the two worlds disagree on navigator.appVersion');
// P1 4.2: the rebuild must be UNCONDITIONAL. An `if (chromeMatch) { ... }`
// guard left this world answering with the REAL string whenever the browser UA
// carried no `Chrome/<4-part>` token (Enterprise UA reduction, a Chromium
// derivative, a UA with the token stripped), while MAIN rebuilds with a '126'
// fallback - one read, two answers. Neither hook may wrap the rebuild in that
// guard, and both must carry the same '126' fallback MAIN uses.
const uaRebuildGuards = (uaSrc.match(/if \(chromeMatch\)/g) || []).length;
const uaFallbacks = (uaSrc.match(/: '126'/g) || []).length;
assert('ISOLATED rebuilds the UA and appVersion unconditionally',
  uaRebuildGuards === 0 && uaFallbacks >= 2,
  'conditional UA rebuild left (' + uaRebuildGuards + ' guard(s), ' + uaFallbacks + ' fallback(s))');
// P1 4.2 (UA-CH): the ISOLATED block used to perturb the REAL high-entropy
// hints (one digit of platformVersion, one digit of fullVersionList) and expose
// the REAL brand list, while MAIN replaced the whole set with the persona's.
// Both must overwrite platformVersion/fullVersionList/platform/mobile outright.
assert('both worlds overwrite the UA-CH hint set, not perturb it',
  uaSrc.includes('out.platformVersion = platformVersion;') &&
  injectorSrc.includes('out.platformVersion = platformVersion;') &&
  uaSrc.includes('out.fullVersionList = fullVersionList;') &&
  injectorSrc.includes('out.fullVersionList = fullVersionList;') &&
  uaSrc.includes('out.mobile = false;') && injectorSrc.includes('out.mobile = false;'),
  'one world still perturbs the real client hints instead of replacing them');
assert('both worlds build navigator.userAgentData once (identity stable)',
  uaSrc.includes('const proxiedUserAgentData = new Proxy(origUserAgentData, handler);') &&
  injectorSrc.includes('const uadProxy = new Proxy(realUAD'),
  'navigator.userAgentData identity is not stable in one world');
assert('the dead UA-CH delta constants are gone',
  !uaSrc.includes('const uaPatchVariation') && !uaSrc.includes('const uaBuildVariation'),
  'the removed build/patch deltas are still declared');
// P2 7.2 (coherent persona): picking every surface independently let one origin
// advertise a MacIntel platform together with an "ANGLE (Apple, Apple M1 ...)"
// renderer and a Win32-shaped client hint - a bundle no real machine produces,
// which is a stronger fingerprint than any single real value. One ':persona' OS
// pick must own the family, and every surface must filter its candidate list by
// it, in BOTH worlds (a divergence between them is itself a fingerprint).
assert('MAIN-world derives one shared persona OS pick',
  injectorSrc.includes("hashString(seed + ':persona')") &&
  injectorSrc.includes("const PERSONA_OS = ['windows', 'mac', 'linux']"),
  'no shared :persona OS pick in page_world_injector.js');
assert('ISOLATED webgl derives the same persona OS pick',
  webglSrc.includes("hashString(((seed >>> 0) || 0) + ':persona')") &&
  webglSrc.includes("const PERSONA_OS = ['windows', 'mac', 'linux']"),
  'hooks_webgl.js does not share the :persona OS pick');
assert('ISOLATED useragent derives the same persona OS pick',
  uaSrc.includes("uaHash(uaSeed + ':persona')") &&
  uaSrc.includes("const PERSONA_OS = ['windows', 'mac', 'linux']"),
  'hooks_useragent.js does not share the :persona OS pick');
// OS tags are what make the bundle coherent: every GPU/WebGPU/UA entry carries
// the family it can come from, and the filter selects only that family.
assert('MAIN-world WebGL personas are OS-tagged and filtered',
  injectorSrc.includes("os: 'windows', vendor:") &&
  injectorSrc.includes("const GPU_PERSONAS = GPU_PERSONAS_ALL.filter((p) => p.os === personaOs)"),
  'GPU_PERSONAS_ALL is not OS-tagged in MAIN');
assert('ISOLATED WebGL personas are OS-tagged and filtered',
  webglSrc.includes("os: 'windows', vendor:") &&
  webglSrc.includes("const GPU_PERSONAS = GPU_PERSONAS_ALL.filter((p) => p.os === personaOs)"),
  'GPU_PERSONAS_ALL is not OS-tagged in hooks_webgl.js');
assert('MAIN-world WebGPU personas are filtered by the same OS pick',
  injectorSrc.includes("const WEBGPU_PERSONAS = WEBGPU_PERSONAS_ALL.filter((p) => p.os === personaOs)"),
  'WebGPU personas are not filtered by the shared OS pick');
assert('MAIN-world UA platforms are filtered by the same OS pick',
  injectorSrc.includes("const platforms = platformsAll.filter((p) => p.os === personaOs)"),
  'UA platforms are not filtered by the shared OS pick');
// The renderer/GPU pair is read from the tagged record, so an Apple GPU can
// never be named while the persona claims Windows.
assert('MAIN-world reads the vendor/renderer pair off the tagged record',
  injectorSrc.includes('const GPU_VENDOR_STRING = gpuPersona.vendor') &&
  injectorSrc.includes('const GPU_RENDERER_STRING = gpuPersona.renderer'),
  'the renderer pair is not read from the OS-tagged record');
assert('ISOLATED webgl reads the vendor/renderer pair off the tagged record',
  webglSrc.includes('const GPU_VENDOR_STRING = gpuPersona.vendor') &&
  webglSrc.includes('const GPU_RENDERER_STRING = gpuPersona.renderer'),
  'the ISOLATED renderer pair is not read from the OS-tagged record');
// Exactly one platform string per OS family in each world: offering 'Win64' or
// 'Linux i686' in the ISOLATED hook while MAIN says 'Win32' / 'Linux x86_64'
// gave one page two different platforms depending on which world answered.
assert('ISOLATED useragent offers one platform string per OS family',
  uaSrc.includes("windows: ['Win32']") && uaSrc.includes("mac: ['MacIntel']") &&
  uaSrc.includes("linux: ['Linux x86_64']"),
  'hooks_useragent.js still offers divergent platform variants');
assert('ISOLATED useragent keeps the real platform as the no-hash fallback',
  uaSrc.includes("if (origPlatform.includes('Mac')) platformCategory = 'mac'")
  , 'hooks_useragent.js lost its native-platform fallback');
// P2 7.3: navigator.gpu used to be entirely unprotected, so a page could read
// the real GPU out of GPUAdapter.info while WebGL reported a persona - two
// answers for one machine. The WebGPU adapter must be keyed on the SAME ':gpu'
// stream as WebGL, and the spoof must live on GPUAdapter.prototype so the
// adapter object itself keeps its native own-property shape.
assert('MAIN-world WebGPU hook exists', injectorSrc.includes('enableWebGPUProtection') &&
  injectorSrc.includes('navigator.gpu') && injectorSrc.includes('requestAdapter'));
assert('WebGPU adapter persona shares the WebGL :gpu stream',
  injectorSrc.includes("hashString(seed + ':gpu') % WEBGPU_PERSONAS.length"));
assert('WebGPU spoof lives on GPUAdapter.prototype, not the adapter instance',
  injectorSrc.includes("Object.getOwnPropertyDescriptor(GPUAdapterCtor.prototype, 'info')") &&
  injectorSrc.includes("Object.defineProperty(GPUAdapterCtor.prototype, 'info'"));
assert('WebGPU hook never draws from a streaming PRNG',
  !/WEBGPU_PERSONAS\[[^\]]*prng/.test(injectorSrc));
// Negative pins must read executable code only: both files legitimately quote
// the removed marker in the comment that documents why it was removed.
const stripComments = (src) => src
  .split(String.fromCharCode(10))
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join(String.fromCharCode(10));
const webglCode = stripComments(webglSrc);
const injectorWebglCode = stripComments(injectorSrc);
assert('neither world leaks an extension marker into a vendor string',
  !webglCode.includes("'(ss-") && !injectorWebglCode.includes("'(ss-"),
  'a vendor string still carries a (ss-...) marker');
assert('media capabilities use stableRoll', mediaSrc.includes('function stableRoll') && mediaSrc.includes("stableRoll('canplay'") && mediaSrc.includes("stableRoll('rtp-sender'"));
assert('media hooks never draw from the streaming PRNG', !/prng\(\)/.test(mediaSrc));
// P1 (world split): MAIN and the ISOLATED copy of enumerateDevices used to
// derive the deviceId from a DIFFERENT key and a differently-seeded FNV-1a
// fold, so one page read two different deviceIds for the same physical device
// depending on which world answered - a one-line cross-world oracle. Both must
// now fold the same string with the same constants and share the ':dev:' /
// ':grp:' / ':label:' keys.
assert('both worlds fold device IDs with the same FNV-1a constants',
  injectorSrc.includes('0x811c9dc5') && webrtcSrc.includes('0x811c9dc5') &&
  injectorSrc.includes('0x01000193') && webrtcSrc.includes('0x01000193'),
  'the two enumerateDevices copies disagree on the hash constants');
assert('ISOLATED enumerateDevices keys deviceId on (seed, kind, deviceId)',
  webrtcSrc.includes("':dev:' + device.kind + ':' + device.deviceId"),
  'the ISOLATED copy still folds a different string than MAIN');
// The MAIN half of the same contract. Without this pin only one side was
// checked, so MAIN could fold `:dev:` over a different tuple (e.g. the label or
// the groupId) and ship a second deviceId for one device with every gate green.
assert('MAIN-world enumerateDevices keys deviceId on (seed, kind, deviceId)',
  injectorSrc.includes("seed + ':dev:' + kind + ':' + deviceId"),
  'MAIN folds a different deviceId tuple than the ISOLATED copy');
assert('both worlds share the :grp: group key and the ss-group- prefix',
  injectorSrc.includes("'ss-group-' + hashDeviceId(seed + ':grp:' + groupId)") &&
  webrtcSrc.includes("'ss-group-' + hashDeviceId(((env.seed >>> 0) || 0) + ':grp:' + device.groupId)"),
  'the two worlds derive different groupIds for one device');
assert('both worlds prefix the deviceId with the same ss- marker',
  injectorSrc.includes("'ss-' + hashDeviceId(seed + ':dev:'") &&
  webrtcSrc.includes("'ss-' + hashDeviceId(((env.seed >>> 0) || 0) + ':dev:'"),
  'the two worlds disagree on the spoofed deviceId prefix');
assert('ISOLATED enumerateDevices keys the label on the shared :label: key',
  webrtcSrc.includes("':label:' + (device.deviceId || device.kind)"),
  'the two worlds still pick different device labels');
assert('font check only upgrades absence, never hides a real font', fontsSrc.includes('if (result === false && globalThis.ssHashString)'));
assert('gamepads are hidden with an iterable, not a null-filled array', sensorsCode.includes('return [];') && !sensorsCode.includes('[null, null, null, null]'));
assert('battery times follow the real charging flag', sensorsSrc.includes('realCharging ? 0 : Infinity') && sensorsSrc.includes('realDischargingTime'));
assert('dead plugin helper stayed deleted', !sensorsCode.includes('defineEmptyArrayLike'));
// P2 7.3: screen.orientation was patched only in the ISOLATED world, so the
// page read the untouched native object - an owner/patch-state oracle that also
// disagreed with the ISOLATED hook. It must now be re-asserted in MAIN, on
// ScreenOrientation.prototype (never on the instance, which would leave an
// enumerable own accessor a page can spot), and must keep the REAL value.
assert('MAIN-world re-asserts screen.orientation on the prototype',
  injectorSrc.includes('window.ScreenOrientation') &&
  injectorSrc.includes("Object.getOwnPropertyDescriptor(OrientationCtor.prototype, prop)") &&
  injectorSrc.includes("Object.defineProperty(OrientationCtor.prototype, prop, {"),
  'screen.orientation is still ISOLATED-only');
assert('screen.orientation re-assert preserves the real angle',
  injectorSrc.includes('desc.get.call(this)') &&
  !/orientation[\s\S]{0,200}angle\s*=\s*0/.test(injectorSrc),
  'the orientation angle must not be rewritten');
// P2 7.3: navigator.keyboard.getLayoutMap() reported the HOST keyboard layout,
// which contradicted the spoofed UA persona - a German layout behind an en-US
// user agent is a one-line oracle, and nothing else covered the surface. The
// layout must be rebuilt from the same seed as the personas, and the resolved
// object must stay a real KeyboardLayoutMap (a Proxy over the native result)
// so `instanceof KeyboardLayoutMap` and every Map method keep working.
assert('MAIN-world spoofs the keyboard layout map from the seed',
  injectorSrc.includes("hashString(seed + ':kbd')") &&
  injectorSrc.includes('kb.getLayoutMap = function'),
  'navigator.keyboard.getLayoutMap is unprotected');
assert('keyboard layout spoof keeps the native KeyboardLayoutMap prototype',
  injectorSrc.includes('new Proxy(shadow, {') &&
  injectorSrc.includes('Object.setPrototypeOf(proxy, Object.getPrototypeOf(realMap))') &&
  injectorSrc.includes('KEYBOARD_LAYOUTS'),
  'the layout map must stay a real KeyboardLayoutMap');
assert('keyboard layout hook never draws from a streaming PRNG',
  !/KEYBOARD_LAYOUTS\[[^\]]*prng/.test(injectorSrc));
// visualViewport was left fully native, so the page could read the untouched
// accessors (owner/patch-state oracle). It is re-asserted on
// VisualViewport.prototype with the REAL values: rewriting the viewport breaks
// every scroll-driven layout, exactly like screen.orientation.
assert('MAIN-world re-asserts visualViewport on the prototype',
  injectorSrc.includes('window.VisualViewport') &&
  injectorSrc.includes('Object.getOwnPropertyDescriptor(VisualViewportCtor.prototype, prop)'),
  'visualViewport is not owned by MAIN');
// P2 4.4: geolocationReads was declared in stats_tracker.js and aggregated by
// service-worker.js but never incremented anywhere, so the dashboard reported a
// permanent 0. The MAIN-world geolocation hooks must report the read over the
// same SS_STAT channel the other MAIN hooks use.
assert('geolocation hooks report their reads to the stats channel',
  /bumpStat\('geolocationReads'\)/.test(injectorSrc) &&
  injectorSrc.includes("bumpStat('geolocationReads')") &&
  (injectorSrc.match(/bumpStat\('geolocationReads'\)/g) || []).length >= 2,
  'geolocationReads is never incremented');
// The MAIN world reports reads by posting a fixed category label, and
// stats_tracker.increment() silently drops any label that is not a key of
// localStats. A typo (or a counter added in MAIN but never declared here) would
// therefore make a surface permanently uncounted with no error anywhere, so the
// two lists must agree exactly.
const statsTrackerSrc = readFileSync(join(ROOT, 'content/stats_tracker.js'), 'utf8');
const declaredCounters = new Set(
  (statsTrackerSrc.match(/^\s{4}([a-zA-Z]+Reads|[a-zA-Z]+Calls|drmReads):\s*0,?$/gm) || [])
    .map((line) => line.trim().replace(/:\s*0,?$/, ''))
);
const mainCategories = new Set(
  (injectorSrc.match(/bumpStat\('([a-zA-Z]+)'\)/g) || [])
    .map((call) => call.slice(10, -2))
);
assert('stats_tracker declares every counter the MAIN world reports',
  declaredCounters.size >= 10 &&
  [...mainCategories].every((c) => declaredCounters.has(c)),
  'MAIN posts a category stats_tracker.js does not declare: ' +
  [...mainCategories].filter((c) => !declaredCounters.has(c)).join(', '));
assert('the MAIN world counts more than one surface',
  mainCategories.size >= 4,
  'only these MAIN categories are reported: ' + [...mainCategories].join(', '));
// P2 7.3: worker-scoped fingerprint surfaces were entirely unprotected. The
// AudioWorklet global scope has no navigator, so the only page-visible value a
// shim could touch there is the audio clock itself. Redefining currentTime as
// `this.__ssTime || 0` broke every time-driven processor AND left the __ssTime
// own property as an oracle, so the realm must keep its NATIVE clock.
// The check runs against comment-stripped source: the explanatory comment
// above names both `__ssTime` and `AudioWorkletGlobalScope.prototype.currentTime`,
// and a raw scan would flag the very prose that documents the removal.
const injectorCode = injectorSrc.replace(/^\s*\/\/.*$/gm, '');
assert('MAIN-world leaves the AudioWorklet clock native',
  injectorCode.includes('AudioWorklet') &&
  !injectorCode.includes('__ssTime') &&
  !/AudioWorkletGlobalScope[\s\S]{0,200}currentTime/.test(injectorCode),
  'the worklet audio clock is still fabricated');
// A module worker cannot call importScripts, so prepending the bootstrap threw
// and the worker never started. The wrapper must detect `{ type: 'module' }`
// and pass the URL through instead of breaking the site.
assert('the worker wrapper never breaks module workers',
  injectorSrc.includes("options.type === 'module'") &&
  injectorSrc.includes('if (!isModule) {'),
  'a module worker would still be handed an importScripts bootstrap');
assert('MAIN-world routes SharedWorker and Worker to the same guarded global',
  injectorSrc.includes('SharedWorker') &&
  injectorSrc.includes('WORKER_GLOBALS'),
  'worker fingerprint surface is unprotected');
// P1 (world split): the worker shim used its own ':worker:cpu' / ':worker:mem'
// hash streams while the page navigator hook used ':nav:cores' / ':nav:memory'.
// A page that spawned a worker and compared the two realms therefore read a
// different core count and memory class - the exact contradiction the shim
// exists to remove. The shim must repeat the values the page hook published.
assert('worker shim repeats the page navigator persona instead of re-deriving it',
  injectorSrc.includes('ssNavCores') &&
  injectorSrc.includes('ssNavMemory') &&
  !/hashString\(seed \+ ':worker:cpu'\)/.test(injectorSrc) &&
  !/hashString\(seed \+ ':worker:mem'\)/.test(injectorSrc),
  'the worker shim still derives its own core/memory values');
// CSS-level fingerprinting: the JS matchMedia shim is invisible to a pure-CSS
// probe, so @media/@supports must be answered from the same seed too.
assert('MAIN-world answers CSS media/supports probes from the seed',
  injectorSrc.includes('CSS_MEDIA_PROFILES') &&
  injectorSrc.includes('CSS.supports'),
  'CSS-level fingerprint is unhandled');
// P2 4.4 (listener oracle): pinning `matches` on the proxy alone was not enough.
// addEventListener was still forwarded to the REAL MediaQueryList, so a `change`
// handler fired with the real list as `event.target`/`this` and re-reading
// `e.target.matches` there returned the un-spoofed value, defeating the shim.
// Both worlds must wrap each listener so the event it sees carries the proxy as
// target/currentTarget and the spoofed `matches`, and must map the wrapper back
// on removal so removeEventListener still detaches the right callback.
assert('MAIN-world matchMedia routes listeners through the spoofing proxy',
  injectorSrc.includes('const listenerMap = new WeakMap()') &&
  injectorSrc.includes('if (prop === \'target\' || prop === \'currentTarget\') return proxy') &&
  injectorSrc.includes('listenerMap.get(listener) || listener') &&
  injectorSrc.includes('return listener.call(proxy, seen)'),
  'matchMedia listeners still observe the real MediaQueryList');
// The injector has TWO matchMedia hooks: the touch block above and the
// CSS-profile block at `priorMatchMedia`. Both hand the page a proxy, and both
// must route addEventListener through the same wrapper - the CSS copy is the
// one a `prefers-color-scheme` listener reaches, so leaving it unwrapped would
// keep the listener oracle open on exactly the query that matters most.
assert('MAIN-world CSS matchMedia also wraps its listeners',
  injectorSrc.includes('const priorMatchMedia = window.matchMedia') &&
  injectorSrc.includes("if (prop === 'matches') return answer") &&
  injectorSrc.includes('target[prop](wrapListener(listener), rest)') &&
  injectorSrc.includes("Object.defineProperty(proxy, 'matches', { value: answer, configurable: true })"),
  'the CSS-profile matchMedia proxy leaks the real matches to listeners');
// Both worlds must read the same config flags with the same opt-OUT rule, or a
// config edit that turns a surface off in one world leaves it on in the other -
// a divergence that is itself the fingerprint. `!== false` means "on unless
// explicitly disabled", which is what DEFAULTS[item.key] === true encodes.
assert('ISOLATED enumerateDevices uses the same !== false opt-out as MAIN',
  webrtcSrc.includes('config.mediaDevices?.randomizeDeviceIds !== false') &&
  webrtcSrc.includes('config.mediaDevices?.spoofDeviceLabels !== false') &&
  injectorSrc.includes("config.mediaDevices.randomizeDeviceIds !== false") &&
  injectorSrc.includes("config.mediaDevices.spoofDeviceLabels !== false"),
  'the two worlds disagree about whether device spoofing is enabled');
// P2 7.2: one explicit WebRTC tri-state replaced three overlapping booleans.
assert('MAIN-world derives the WebRTC tri-state',
  injectorSrc.includes('effectiveWebrtcMode') &&
  injectorSrc.includes('CONFIG_GROUP_STRING_KEYS') &&
  injectorSrc.includes('iceTransportPolicy'),
  'the WebRTC policy is not derived in MAIN');
// P2 7.2: the three overlapping WebRTC booleans were replaced by one explicit
// tri-state, and BOTH worlds have to derive the effective policy with the same
// rule or they disagree about the same connection (itself a fingerprint). The
// legacy booleans must stay readable so an older stored config still works.
assert('MAIN-world derives the WebRTC tri-state, not the legacy booleans',
  injectorSrc.includes('effectiveWebrtcMode') &&
  injectorSrc.includes("const WEBRTC_MODES = ['off', 'block-host-srflx', 'relay-only']") &&
  injectorSrc.includes('CONFIG_GROUP_STRING_KEYS'),
  'webrtc.mode is not whitelisted in MAIN');
// P2 5.3 (toString prefix): an accessor shim is a function too, and a page can
// reach it with Object.getOwnPropertyDescriptor(Navigator.prototype,
// 'userAgent').get and then call .toString() on it. V8 prints a native
// accessor as `get userAgent() { [native code] }`, so answering the plain
// `function userAgent() { [native code] }` form is itself the tell. The guard
// must register accessors separately from methods, remember the `get `/`set `
// prefix per function, and emit the canonical accessor shape.
assert('MAIN-world toString guard keeps the accessor get/set prefix',
  injectorSrc.includes('const nativeLabels = new WeakMap()') &&
  injectorSrc.includes('registerAccessors') &&
  injectorSrc.includes("nativeLabels.set(desc.get, 'get ' + key)") &&
  injectorSrc.includes("nativeLabels.set(desc.set, 'set ' + key)") &&
  injectorSrc.includes("'get ' + parts[1] + '() { [native code] }'") &&
  injectorSrc.includes("'set ' + parts[1] + '(v) { [native code] }'"),
  'an accessor shim would print as a plain function in MAIN');
// P2 5.3 (toString prefix, completeness): the screen block patches MORE
// accessors than the navigator block - availLeft/availTop are pinned to 0 by
// the same defineGetter helper, devicePixelRatio lives on the WINDOW object
// natively, and screen.orientation is re-asserted on ScreenOrientation.prototype.
// Each of those getters was left unregistered, so a page could read
// `Object.getOwnPropertyDescriptor(Screen.prototype, 'availLeft').get.toString()`
// and get the hook closure back instead of `[native code]` - an oracle for
// exactly the fields the extension spoofs. Pin that every one of them is fed to
// registerAccessors.
assert('MAIN-world registers every patched screen/window accessor for toString',
  injectorSrc.includes("'availLeft', 'availTop'") &&
  injectorSrc.includes("registerAccessors(window, ['devicePixelRatio'])") &&
  injectorSrc.includes('registerAccessors(window.ScreenOrientation') &&
  injectorSrc.includes("['type', 'angle']"),
  'a screen/window accessor shim would still print its hook source');
// P2 5.3 (toString prefix, second pass): the first pass only covered
// Navigator.prototype and Screen.prototype. The WebGPU adapter-info getter,
// every VisualViewport metric, performance.memory, the connection getters and
// document.hidden/visibilityState are accessor shims too, and the plain-method
// closures (getBattery, getGamepads, decodingInfo, getLayoutMap,
// queryUsageAndQuota, RTCRtp*Sender/Receiver.getCapabilities,
// getEntriesByType, Intl.DateTimeFormat, CSS.supports) printed their hook
// source as well. Pin the second pass so a future hook cannot quietly skip
// registration again.
assert('MAIN-world registers the second-pass accessor and method shims',
  injectorSrc.includes("registerAccessors(window.GPUAdapter && window.GPUAdapter.prototype, ['info'])") &&
  injectorSrc.includes("registerAccessors(performance, ['memory'])") &&
  injectorSrc.includes("'effectiveType', 'downlink'") &&
  injectorSrc.includes('registerAccessors(window.Document && Document.prototype') &&
  injectorSrc.includes("['hidden', 'visibilityState']") &&
  injectorSrc.includes("registerNative(navigator, 'getGamepads')") &&
  injectorSrc.includes("registerNative(navigator.mediaCapabilities, 'decodingInfo')") &&
  injectorSrc.includes("registerNative(performance, 'getEntriesByType')") &&
  injectorSrc.includes("registerNative(typeof CSS !== 'undefined' ? CSS : null, 'supports')"),
  'a second-pass shim would still print its hook source');
// P2 5.3 (toString prefix, third pass): the WebRTC candidate handler and both
// geolocation entry points are redefined as own functions on the instance or on
// navigator.geolocation, and none of them were registered. A page calling
// `navigator.geolocation.getCurrentPosition.toString()` therefore read the hook
// closure straight back. Pin the third pass so this class of miss stays closed.
assert('MAIN-world registers the third-pass method shims',
  injectorSrc.includes("RTCPeerConnection.prototype, 'addIceCandidate'") &&
  injectorSrc.includes("registerNative(navigator.geolocation, 'getCurrentPosition')") &&
  injectorSrc.includes("registerNative(navigator.geolocation, 'watchPosition')"),
  'a third-pass method shim would still print its hook source');
// P2 5.3 (toString prefix, fourth pass): the WebGPU entry point and the
// FontFaceSet.check shim were the last two page-visible closures the earlier
// passes missed. Pin them so a future hook cannot quietly skip registration
// again - the guard's whole value is that the registered set stays complete.
assert('MAIN-world registers the fourth-pass method shims',
  injectorSrc.includes("registerNative(navigator.gpu, 'requestAdapter')") &&
  injectorSrc.includes("registerNative(document.fonts, 'check')"),
  'a fourth-pass method shim would still print its hook source');
// P2 5.3 (toString prefix, fifth pass): a sweep of every `x.y = function` and
// `Object.defineProperty` site against the registered names left exactly three
// page-visible shims uncovered - the RTCPeerConnection CONSTRUCTOR itself (its
// prototype methods were registered, the global wrapper was not), the
// FontFaceSet Symbol.iterator the font block redefines, and the timezone
// `resolvedOptions` that used to be an own property of every instance. The
// last one was also an own-property leak: real Chrome reports [] from
// Object.getOwnPropertyNames(new Intl.DateTimeFormat()) while the shim reported
// ['resolvedOptions']. It is now patched on the shared prototype.
assert('MAIN-world registers the fifth-pass shims',
  injectorSrc.includes("registerNative(window, 'RTCPeerConnection')") &&
  injectorSrc.includes("registerNative(document.fonts && Object.getPrototypeOf(document.fonts), Symbol.iterator)") &&
  injectorSrc.includes("registerNative(Intl.DateTimeFormat && Intl.DateTimeFormat.prototype, 'resolvedOptions')"),
  'a fifth-pass shim would still print its hook source');
assert('timezone resolvedOptions is patched on the prototype, not per instance',
  injectorSrc.includes('const origResolvedOptions = OrigIntlDateTimeFormat.prototype.resolvedOptions;') &&
  !injectorSrc.includes('const origResolvedOptions = instance.resolvedOptions;'),
  'Intl.DateTimeFormat instances still carry an own resolvedOptions');
// P2 5.5 (cross-world parity): the ISOLATED timezone hook had the same
// own-property leak and the same toString oracle, so both worlds must patch the
// PROTOTYPE. A per-instance closure in either world is a one-line detector for
// exactly the surface the extension spoofs.
assert('ISOLATED timezone resolvedOptions is patched on the prototype too',
  tzSrc.includes('const origResolvedOptions = OrigDateTimeFormat.prototype.resolvedOptions;') &&
  !tzSrc.includes('const origResolvedOptions = formatter.resolvedOptions;'),
  'hooks_timezone.js still shadows resolvedOptions per instance');
assert('WebRTC relay-only reaches the MAIN-world constructor',
  injectorSrc.includes('iceTransportPolicy') &&
  injectorSrc.includes('forceRelay'),
  'relay-only never reaches the MAIN constructor');

section('MAIN-world handshake (behavioural)');
// P0: the injector's message listener was briefly marked `{ once: true }`. Every
// substring check in verify.mjs still passed, but the extension was dead at
// runtime: the ISOLATED bootstrap sends SS_PAGE_WORLD_HELLO first, that HELLO
// consumed the once-listener, and the later SS_INIT_PAGE_HOOKS had no receiver -
// so every MAIN-world hook stayed uninstalled. These pins execute the real
// injector in an isolated vm context and drive the real message flow, which is
// the only way a listener-lifetime regression can be caught.
function loadInjector () {
  const listeners = [];
  const posted = [];
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), error: () => {}, warn: () => {} },
    crypto: {
      getRandomValues (buf) { for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + 11) & 0xff; return buf; }
    },
    location: { origin: 'https://handshake.test' },
    navigator: {},
    performance: {},
    document: {},
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (type, fn) => { if (type === 'message') listeners.push(fn); };
  sandbox.window.postMessage = (data, origin) => { posted.push({ data, origin }); };
  createContext(sandbox);
  runInContext(readFileSync(join(ROOT, 'content/page_world_injector.js'), 'utf8'), sandbox, {
    filename: 'page_world_injector.js'
  });
  // Inside a vm context `window` is the contextified inner global, which is NOT
  // the same object reference as the outer sandbox we handed to createContext().
  // The injector guards every message with `event.source !== window`, so a
  // dispatch whose source is the outer object is rejected before the handshake
  // logic runs and the test would fail for the wrong reason. Capture the inner
  // global and dispatch from it.
  const innerGlobal = runInContext('globalThis', sandbox);
  return { sandbox, innerGlobal, listeners, posted, logs };
}

function driveHandshake () {
  const inj = loadInjector();
  const readyCount = () => inj.posted.filter((m) => m.data && m.data.type === 'SS_PAGE_WORLD_READY').length;
  const initLogs = () => inj.logs.filter((l) => l.indexOf('Initializing page-world hooks') !== -1).length;
  const dispatch = (data) => {
    // Mirror the two guards the injector applies to every message: the event has
    // to come from this window and from the page's own origin.
    const event = { source: inj.innerGlobal, origin: inj.sandbox.location.origin, data };
    inj.listeners.forEach((fn) => fn(event));
  };
  return { inj, readyCount, initLogs, dispatch };
}

const hs = driveHandshake();
assert('injector registers a message listener', hs.inj.listeners.length === 1, String(hs.inj.listeners.length));
const readyAtLoad = hs.readyCount();
assert('injector announces READY at document_start', readyAtLoad >= 1, String(readyAtLoad));
const firstReady = hs.inj.posted.filter((m) => m.data && m.data.type === 'SS_PAGE_WORLD_READY')[0];
assert('READY carries a 32-hex nonce',
  typeof (firstReady && firstReady.data.nonce) === 'string' && /^[0-9a-f]{32}$/.test(firstReady.data.nonce),
  String(firstReady && firstReady.data.nonce));

hs.dispatch({ type: 'SS_PAGE_WORLD_HELLO', protocol: 1 });
assert('HELLO is answered with a fresh READY', hs.readyCount() === readyAtLoad + 1, String(hs.readyCount()));

// The forged attempt must be refused WITHOUT latching the one-shot guard: a
// malformed first message used to set ssInitialized, so the genuine bootstrap
// post that followed was ignored and no hook ever installed.
hs.dispatch({ type: 'SS_INIT_PAGE_HOOKS', protocol: 1, nonce: 'deadbeef', config: { debug: true }, seed: 1 });
assert('a message with the wrong nonce is refused', hs.initLogs() === 0, String(hs.initLogs()));

const nonce = firstReady.data.nonce;
hs.dispatch({ type: 'SS_INIT_PAGE_HOOKS', protocol: 1, nonce, config: { debug: true }, seed: 1 });
// This is the pin that catches `{ once: true }`: with a once-listener the HELLO
// above would already have removed the listener, so nothing would be installed
// here and this count would stay 0.
assert('the genuine init still installs after HELLO', hs.initLogs() === 1, String(hs.initLogs()));

hs.dispatch({ type: 'SS_INIT_PAGE_HOOKS', protocol: 1, nonce, config: { debug: true }, seed: 1 });
assert('the one-shot latch rejects a repeated init', hs.initLogs() === 1, String(hs.initLogs()));

hs.dispatch({ type: 'SS_INIT_PAGE_HOOKS', protocol: 1, nonce, config: null, seed: 1 });
assert('a malformed payload cannot re-latch the injector', hs.initLogs() === 1, String(hs.initLogs()));

section('self-test surface (feature 7.3)');
// The audit asked for a self-test the user can actually run. The old sampler
// hashed the literal string "no-webgl"/"no-audio" into a perfectly plausible
// digest, so a tab where nothing had been shaped still produced a healthy-
// looking composite and proved nothing. The report now names every surface the
// tab could not reach instead of folding it into the hash, and the Options pane
// drives it through a message the page itself can never observe.
const testSrc = readFileSync(join(ROOT, 'content/test_fingerprint.js'), 'utf8');
const mainSrc = readFileSync(join(ROOT, 'content/content_main.js'), 'utf8');
const optionsSrc = readFileSync(join(ROOT, 'options/options.js'), 'utf8');
const optionsHtml = readFileSync(join(ROOT, 'options/options.html'), 'utf8');
const stealthSrc = readFileSync(join(ROOT, 'core/stealth.js'), 'utf8');

assert('the sampler publishes a structured report, not just a hash',
  testSrc.includes('async function testFingerprintReport') &&
  testSrc.includes('ssTestFingerprintReport') &&
  testSrc.includes('composite:') &&
  testSrc.includes('parts: parts') &&
  testSrc.includes('warnings: warnings'),
  'the self-test still returns only a composite digest');
assert('an unreachable surface is named instead of hashed',
  testSrc.includes("'no-webgl': 'WebGL is not available in this tab'") &&
  testSrc.includes("'no-audio': 'Web Audio is not available in this tab'") &&
  testSrc.includes("'noctx': 'Canvas 2D context is not available in this tab'") &&
  testSrc.includes('UNAVAILABLE[sample]'),
  'a missing surface would still produce a plausible digest');
assert('the composite digest still delegates to the report',
  testSrc.includes('const report = await testFingerprintReport();') &&
  testSrc.includes('return report.composite;'),
  'ssTestFingerprint no longer shares the report path');
assert('the ISOLATED world answers the self-test request',
  mainSrc.includes("message.type !== 'SS_RUN_SELF_TEST'") &&
  mainSrc.includes('ssTestFingerprintReport') &&
  mainSrc.includes('sendResponse({ success: true, report: r })') &&
  mainSrc.includes('chrome.runtime.onMessage.addListener'),
  'no ISOLATED listener answers the self-test');
// The listener must live in the ISOLATED world only. A MAIN-world copy would
// hand the page the exact oracle the hook guard exists to hide.
assert('the MAIN-world injector never answers the self-test',
  !injectorSrc.includes('SS_RUN_SELF_TEST'),
  'the self-test listener leaked into the page world');
assert('the Options pane drives the self-test against a real tab',
  optionsSrc.includes("chrome.tabs.sendMessage(tab.id, { type: 'SS_RUN_SELF_TEST' })") &&
  optionsSrc.includes("diagnosticRow('Status', 'Not installed on this tab - reload it and run the test again.')") &&
  optionsSrc.includes('report.warnings') &&
  optionsSrc.includes('report.composite'),
  'the Options self-test would not report anything');
assert('the self-test card exists in the Options markup',
  optionsHtml.includes('id="selfTestBody"') &&
  optionsHtml.includes('id="runSelfTestBtn"') &&
  optionsHtml.includes('Live self-test'),
  'the Run self-test button is not wired into the page');
// Every ss* global must be concealed, and verify.mjs derives that set from the
// sources; this keeps the new global on the concealment list it checks.
assert('ssTestFingerprintReport is concealed from enumeration',
  stealthSrc.includes("'ssTestFingerprintReport'"),
  'the new global would show up in Object.keys(globalThis)');

section('WebGPU adapter parity (P2 7.3)');
// navigator.gpu was unprotected, so a page could read the real GPU out of
// GPUAdapter.info while the WebGL hook reported a persona - two answers for one
// machine, which is itself a fingerprint. The WebGPU persona must be picked from
// the same ':gpu' key and the same OS list ordering as the WebGL persona, or the
// two surfaces disagree about the vendor they report.
assert('MAIN-world picks the WebGPU persona from the same :gpu key',
  injectorSrc.includes("hashString(seed + ':gpu') % WEBGPU_PERSONAS.length") &&
  injectorSrc.includes('WEBGPU_PERSONAS_ALL.filter((p) => p.os === personaOs)'),
  'WebGPU and WebGL would report different vendors');
assert('the WebGPU persona list keeps the WebGL os tags and order',
  ['windows', 'mac', 'linux'].every((os) => injectorSrc.includes("os: '" + os + "'")) &&
  injectorSrc.indexOf("os: 'windows'") < injectorSrc.indexOf("os: 'mac'") &&
  injectorSrc.indexOf("os: 'mac'") < injectorSrc.indexOf("os: 'linux'"),
  'the two GPU lists no longer line up by index');
// The spoof has to live in the prototype getter, keyed by a WeakMap on the
// adapter instance: an own property on the adapter (or a rewritten `info`
// object) is an own-property oracle a page can spot with one call.
assert('the WebGPU spoof never leaves an own property on the adapter',
  injectorSrc.includes('new WeakMap()') &&
  injectorSrc.includes('adapterPersona.set(adapter, webgpuPersona)') &&
  injectorSrc.includes("Object.getOwnPropertyDescriptor(GPUAdapterCtor.prototype, 'info')") &&
  injectorSrc.includes('const origInfoDesc = Object.getOwnPropertyDescriptor'),
  'the adapter info getter is not a prototype-level shim');
assert('the WebGPU info accessor stays non-enumerable and configurable',
  injectorSrc.includes('enumerable: false') &&
  injectorSrc.includes('configurable: true') &&
  injectorSrc.includes('origInfoDesc.get.call(this)'),
  'the redefined info accessor is an own-property tell');
// requestAdapter returns a promise; a hook that forgets `.then` hands the page a
// raw promise and the persona never reaches the adapter at all.
assert('the WebGPU requestAdapter hook tags the resolved adapter',
  injectorSrc.includes('if (result && typeof result.then === \'function\')') &&
  injectorSrc.includes('return result.then(tagAdapter)'),
  'the WebGPU persona never reaches the adapter');

console.log('');
console.log((failures === 0 ? 'PASS' : 'FAIL') + ' - ' + (checks - failures) + '/' + checks + ' tests passed');
process.exit(failures === 0 ? 0 : 1);
