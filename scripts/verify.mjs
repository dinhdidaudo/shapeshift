// ShapeShift - structural + syntax verification for the MV3 extension.
// Usage: node scripts/verify.mjs [--lint]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LINT = process.argv.includes('--lint');
// The packaging build runs this gate *before* it copies the runtime tree into
// dist/, so the freshness comparison would always fail on a stale dist/ and
// make the build impossible to run. build.mjs passes --no-dist for that first
// pass and then runs the full gate against the freshly written dist/.
const SKIP_DIST = process.argv.includes('--no-dist');
let failures = 0;
let checks = 0;

const ok = (label) => { checks++; console.log('  ok   ' + label); };
const fail = (label, detail) => { failures++; checks++; console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); };
const section = (name) => { console.log(''); console.log(name); };
const text = (file) => readFileSync(file, 'utf8');

section('manifest.json');
const manifestPath = join(ROOT, 'manifest.json');
let manifest = null;
if (!existsSync(manifestPath)) {
  fail('manifest exists');
} else {
  try { manifest = JSON.parse(text(manifestPath)); ok('parses as JSON'); }
  catch (err) { fail('parses as JSON', err.message); }
}

if (manifest) {
  manifest.manifest_version === 3 ? ok('manifest_version is 3') : fail('manifest_version is 3');
  // Architecture section 4 / i18n: the visible name lives in _locales/<locale>/messages.json.
  // The manifest must reference it through __MSG_*__ and declare a default locale,
  // otherwise Chrome refuses to load the extension.
  const LOCALE_MSG = /^__MSG_[A-Za-z0-9_]+__$/;
  const i18nReady = manifest.default_locale === 'en' && LOCALE_MSG.test(String(manifest.name));
  i18nReady ? ok('name is localized via default_locale') : fail('name is localized via default_locale', String(manifest.name));
  (manifest.short_name === undefined || LOCALE_MSG.test(String(manifest.short_name)))
    ? ok('short_name is localized or absent')
    : fail('short_name is localized or absent', String(manifest.short_name));
  (manifest.description === undefined || LOCALE_MSG.test(String(manifest.description)))
    ? ok('description is localized or absent')
    : fail('description is localized or absent');
  manifest.author === 'Phạm Văn Định' ? ok('author is Phạm Văn Định') : fail('author is Phạm Văn Định', String(manifest.author));
  /^[0-9]+[.][0-9]+[.][0-9]+$/.test(String(manifest.version)) ? ok('version is semver') : fail('version is semver');

  const allowed = new Set(['storage', 'tabs', 'alarms', 'notifications']);
  const extra = (manifest.permissions || []).filter((p) => !allowed.has(p));
  extra.length === 0 ? ok('no unexpected permissions') : fail('no unexpected permissions', extra.join(', '));

  const referenced = [];
  if (manifest.background && manifest.background.service_worker) referenced.push(manifest.background.service_worker);
  if (manifest.action && manifest.action.default_popup) referenced.push(manifest.action.default_popup);
  if (manifest.options_page) referenced.push(manifest.options_page);
  (manifest.content_scripts || []).forEach((cs) => {
    (cs.js || []).forEach((f) => referenced.push(f));
    (cs.css || []).forEach((f) => referenced.push(f));
  });
  (manifest.web_accessible_resources || []).forEach((war) => (war.resources || []).forEach((f) => referenced.push(f)));
  Object.keys(manifest.icons || {}).forEach((k) => referenced.push(manifest.icons[k]));
  if (manifest.action && manifest.action.default_icon) Object.keys(manifest.action.default_icon).forEach((k) => referenced.push(manifest.action.default_icon[k]));

  const missing = referenced.filter((rel) => !existsSync(join(ROOT, rel)));
  missing.length === 0 ? ok('all ' + referenced.length + ' referenced paths exist') : fail('all referenced paths exist', missing.join(', '));

  // _locales is a manifest-referenced directory that the generic path check
  // above cannot see: it is loaded by convention, not by an explicit path.
  if (manifest.default_locale) {
    existsSync(join(ROOT, '_locales', manifest.default_locale, 'messages.json'))
      ? ok('default locale catalog is referenced correctly')
      : fail('default locale catalog is referenced correctly', manifest.default_locale);
  }

  const isolated = (manifest.content_scripts || []).filter((cs) => cs.world === 'ISOLATED')[0];
  if (!isolated) {
    fail('ISOLATED content script present');
  } else {
    const js = isolated.js || [];
    const bootIdx = js.indexOf('content/bootstrap.js');
    const mainIdx = js.indexOf('content/content_main.js');
    const hooks = js.map((f, i) => (f.indexOf('content/hooks_') === 0 ? i : -1)).filter((i) => i >= 0);
    bootIdx > 0 && hooks.every((i) => i < bootIdx) ? ok('hooks load before bootstrap.js') : fail('hooks load before bootstrap.js');
    mainIdx > bootIdx ? ok('content_main.js loads last') : fail('content_main.js loads last');

    // P0 1.2/1.3: the debug self-test reads globalThis.ssTestFingerprint, which
    // only content/test_fingerprint.js defines. The file existed in the tree but
    // was never listed in the manifest, so the sampler was always undefined and
    // the debug Before/After pair silently degraded to a no-op - the diagnostic
    // looked wired while measuring nothing. It must ship, and load before the
    // consumer that reads the global.
    const testIdx = js.indexOf('content/test_fingerprint.js');
    testIdx >= 0 && testIdx < mainIdx
      ? ok('test_fingerprint.js loads before its consumer')
      : fail('test_fingerprint.js loads before its consumer', 'test=' + testIdx + ' main=' + mainIdx);

    // Architecture §4: core/config.js builds its defaults from the schema, so
    // the schema has to be loaded first. Leaving it out silently gave every
    // content script an empty default config (all protection at 0).
    const schemaIdx = js.indexOf('core/config-schema.js');
    const cfgIdx = js.indexOf('core/config.js');
    schemaIdx >= 0 && cfgIdx >= 0 && schemaIdx < cfgIdx
      ? ok('config-schema.js loads before config.js')
      : fail('config-schema.js loads before config.js', 'schema=' + schemaIdx + ' config=' + cfgIdx);
  }
}

section('localization');
// A manifest that uses __MSG_*__ without a matching catalog loads as a broken
// extension, and Chrome silently falls back to the raw placeholder string.
// LOCALE_MSG above is block-scoped to the manifest check, so declare it here too.
const LOCALE_PLACEHOLDER = /^__MSG_[A-Za-z0-9_]+__$/;
if (manifest && manifest.default_locale) {
  const messagesPath = join(ROOT, '_locales', manifest.default_locale, 'messages.json');
  if (!existsSync(messagesPath)) {
    fail('default locale catalog exists', '_locales/' + manifest.default_locale + '/messages.json');
  } else {
    let catalog = null;
    try { catalog = JSON.parse(text(messagesPath)); ok('default locale catalog parses as JSON'); }
    catch (err) { fail('default locale catalog parses as JSON', err.message); }
    if (catalog) {
      // P2 7.4: the scan used to look only at manifest.name / short_name /
      // description, so `action.default_title: "__MSG_appName__"` - and any
      // placeholder in the popup/options markup - slipped through. A missing
      // catalog entry there renders the raw __MSG_*__ token in the toolbar
      // tooltip, which every other check happily passed. Collect every
      // placeholder from the manifest, the popup/options markup and their
      // controllers instead of enumerating three fields by hand.
      const LOCALE_MSG = /^__MSG_[A-Za-z0-9_]+__$/;
      const PLACEHOLDER_G = /__MSG_([A-Za-z0-9_]+)__/g;
      const placeholderSources = [text(manifestPath)];
      ['popup', 'options'].forEach((dir) => {
        const abs = join(ROOT, dir);
        if (!existsSync(abs)) return;
        readdirSync(abs).forEach((entry) => {
          const full = join(abs, entry);
          if (!statSync(full).isFile()) return;
          if (['.html', '.js', '.css'].indexOf(extname(full)) === -1) return;
          placeholderSources.push(text(full));
        });
      });
      const placeholders = [];
      const seenPlaceholder = new Set();
      placeholderSources.forEach((src) => {
        let m;
        PLACEHOLDER_G.lastIndex = 0;
        while ((m = PLACEHOLDER_G.exec(src)) !== null) {
          if (seenPlaceholder.has(m[1])) continue;
          seenPlaceholder.add(m[1]);
          placeholders.push(m[1]);
        }
      });
      const missingMsgs = placeholders.filter((k) => !catalog[k] || typeof catalog[k].message !== 'string');
      missingMsgs.length === 0
        ? ok('every __MSG_*__ placeholder resolves in the catalog')
        : fail('every __MSG_*__ placeholder resolves in the catalog', missingMsgs.join(', '));

      // P2 (i18n drift): nothing compared the shipped locales with each other,
      // so a key added to _locales/en/ but not _locales/vi/ shipped a catalog
      // that silently renders the raw __MSG_*__ placeholder in that language.
      const localeDirs = readdirSync(join(ROOT, '_locales'))
        .filter((d) => statSync(join(ROOT, '_locales', d)).isDirectory());
      const localeKeys = {};
      localeDirs.forEach((d) => {
        const p = join(ROOT, '_locales', d, 'messages.json');
        if (!existsSync(p)) { localeKeys[d] = null; return; }
        try { localeKeys[d] = Object.keys(JSON.parse(text(p))).sort(); }
        catch (e) { localeKeys[d] = null; }
      });
      const unreadable = localeDirs.filter((d) => localeKeys[d] === null);
      unreadable.length === 0
        ? ok('every _locales/<locale>/messages.json parses')
        : fail('every _locales/<locale>/messages.json parses', unreadable.join(', '));
      const baseKeys = localeKeys[manifest.default_locale] || [];
      const drifted = localeDirs.filter((d) => {
        const keys = localeKeys[d] || [];
        return keys.length !== baseKeys.length || keys.some((k, i) => k !== baseKeys[i]);
      });
      drifted.length === 0
        ? ok('all locale catalogs define the same keys')
        : fail('all locale catalogs define the same keys', drifted.join(', '));

      // P2 7.4: Chrome caps the manifest description at 132 characters, and the
      // localized string is what actually ships. A catalog entry that is over
      // the cap is rejected by the Web Store at upload time, not at load time,
      // so nothing local caught it.
      const tooLongDesc = [];
      localeDirs.forEach((d) => {
        const p = join(ROOT, '_locales', d, 'messages.json');
        if (!existsSync(p)) return;
        try {
          const c = JSON.parse(text(p));
          const msg = c.appDescription && c.appDescription.message;
          if (typeof msg === 'string' && msg.length > 132) tooLongDesc.push(d + '=' + msg.length);
        } catch (e) { /* parse failure already reported above */ }
      });
      tooLongDesc.length === 0
        ? ok('appDescription fits the 132-character store limit')
        : fail('appDescription fits the 132-character store limit', tooLongDesc.join(', '));
    }
  }
}

// The manifest declares the oldest Chrome the hooks may run on. A missing or
// malformed value silently means "any Chrome", which is how storage.session and
// the other APIs the hooks rely on could ship against a browser that lacks them.
if (manifest) {
  const mcv = String(manifest.minimum_chrome_version || '');
  /^[0-9]+$/.test(mcv) && Number(mcv) >= 114
    ? ok('minimum_chrome_version pins a supported floor')
    : fail('minimum_chrome_version pins a supported floor', mcv || '(missing)');
}

section('config single source of truth');
// The defaults used to be copy-pasted into popup.js and options.js; a drifted
// copy is what made the Options switches disagree with the hooks. Both pages
// now read globalThis.ssFlatDefaults from core/config-schema.js, and each HTML
// entry has to load that file before its controller.
const controllers = [
  ['popup/popup.html', 'popup/popup.js'],
  ['options/options.html', 'options/options.js']
];
const badDefaults = [];
const badOrder = [];
controllers.forEach(([htmlRel, jsRel]) => {
  const js = text(join(ROOT, jsRel));
  if (!js.includes('globalThis.ssFlatDefaults')) badDefaults.push(jsRel);
  if (/const\s+DEFAULTS\s*=\s*\{/.test(js)) badDefaults.push(jsRel + ' (inline literal)');
  const html = text(join(ROOT, htmlRel));
  const schemaAt = html.indexOf('../core/config-schema.js');
  const ctrlAt = html.indexOf(jsRel.split('/')[1]);
  if (schemaAt < 0 || ctrlAt < 0 || schemaAt > ctrlAt) badOrder.push(htmlRel);
});
badDefaults.length === 0
  ? ok('popup/options derive DEFAULTS from the shared schema')
  : fail('popup/options derive DEFAULTS from the shared schema', badDefaults.join(', '));
badOrder.length === 0
  ? ok('popup/options load config-schema.js first')
  : fail('popup/options load config-schema.js first', badOrder.join(', '));

section('MAIN-world handshake');
// P0 1.6 / Security §3: the MAIN-world injector must publish a per-load nonce
// and refuse an SS_INIT_PAGE_HOOKS message that does not echo it. Without this
// pair of checks a refactor could silently drop the nonce and re-open the
// "page forges the init message" hole with every gate still green.
const injectorSrc = text(join(ROOT, 'content/page_world_injector.js'));
const bootstrapSrc = text(join(ROOT, 'content/bootstrap.js'));
// The injector's message listener must survive the HELLO that bootstrap.js
// always sends *before* SS_INIT_PAGE_HOOKS. `{ once: true }` consumed that
// first message and silently uninstalled every MAIN-world hook while every
// substring check above still passed - the exact P0 that shipped. Two static
// guards close it: the option must not appear on the listener, and the file
// must not carry the string at all (comments excepted below).
const injectorCode = injectorSrc
  .split(String.fromCharCode(10))
  .map((l) => {
    // Drop a trailing `//` comment (the P0 note lives there) while keeping
    // `https://` URLs intact: only a `//` not preceded by `:` starts a comment.
    const idx = l.search(/(^|[^:])\/\//);
    return idx === -1 ? l : l.slice(0, idx + 1);
  })
  .filter((l) => !l.trim().startsWith('//'))
  .join(String.fromCharCode(10));
const nonceChecks = [
  ['injector publishes a nonce', injectorSrc.includes('SS_PAGE_WORLD_READY') && injectorSrc.includes('nonce: ssNonce')],
  ['injector refuses a message without the nonce', /event\.data\.nonce !== ssNonce/.test(injectorSrc)],
  ['injector answers SS_PAGE_WORLD_HELLO', injectorSrc.includes('SS_PAGE_WORLD_HELLO')],
  ['bootstrap listens for SS_PAGE_WORLD_READY', bootstrapSrc.includes("'SS_PAGE_WORLD_READY'")],
  ['bootstrap echoes the nonce', bootstrapSrc.includes('nonce: pageNonce')],
  ['bootstrap asks for the nonce', bootstrapSrc.includes('SS_PAGE_WORLD_HELLO')],
  // P0 2.1: the listener must not be one-shot.
  ['injector does not register a one-shot message listener', !/once\s*:\s*true/.test(injectorCode)],
  ['injector keeps its listener attached across messages', !/removeEventListener\s*\(\s*['"]message['"]/.test(injectorCode)]
];
const nonceFailures = nonceChecks.filter(([, pass]) => !pass).map(([label]) => label);
nonceFailures.length === 0
  ? ok('nonce handshake is wired on both sides')
  : fail('nonce handshake is wired on both sides', nonceFailures.join(', '));

section('MAIN-world statistics bridge');
// P2 7.1: the counters used to be ISOLATED-only, so a page that only ever read
// the MAIN-world patched prototypes showed zero in the popup. The injector now
// reports each read as an SS_STAT message and stats_tracker.js folds it into the
// same counter the ISOLATED hooks use. Pin both halves plus the validating
// receiver: dropping either side leaves every gate green while the popup
// silently reports nothing for page-visible reads.
const trackerSrc = text(join(ROOT, 'content/stats_tracker.js'));
const statCategories = (injectorSrc.match(/bumpStat\('([a-zA-Z]+)'\)/g) || [])
  .map((m) => m.slice(10, -2));
const unknownCategories = statCategories.filter((c) => trackerSrc.indexOf(c + ': 0') === -1);
// P2 7.1 (coverage): the bridge is only worth anything if EVERY counter the
// popup shows can move from a page-visible read. Derive the counter list from
// the tracker itself so a new counter cannot be added without a MAIN-world
// reporter, and so a reporter cannot be dropped while the gates stay green.
const localStatsBlock = (trackerSrc.match(/const localStats = \{([\s\S]*?)\};/) || [])[1] || '';
const counterNames = (localStatsBlock.match(/([a-zA-Z]+): 0,/g) || [])
  .map((m) => m.slice(0, -4));
const uncoveredCounters = counterNames.filter((c) => statCategories.indexOf(c) === -1);
const statChecks = [
  ['injector reports MAIN-world reads', injectorSrc.indexOf("type: 'SS_STAT'") !== -1 && statCategories.length >= 4],
  ['every reported category is a real counter', unknownCategories.length === 0],
  ['every counter has a MAIN-world reporter', counterNames.length >= 10 && uncoveredCounters.length === 0],
  ['tracker listens for SS_STAT', trackerSrc.indexOf("'SS_STAT'") !== -1],
  ['tracker validates the protocol', trackerSrc.indexOf('data.protocol !== 1') !== -1],
  ['tracker folds the label into a counter', trackerSrc.indexOf('increment(data.category)') !== -1],
  ['tracker rejects an unknown category', trackerSrc.indexOf('hasOwnProperty.call(localStats, category)') !== -1]
];
const statFailures = statChecks.filter(([, pass]) => !pass).map(([label]) => label);
statFailures.length === 0
  ? ok('MAIN-world reads reach the shared counters')
  : fail('MAIN-world reads reach the shared counters', statFailures.concat(unknownCategories, uncoveredCounters).join(', '));

section('Screen world ownership');
// P2 5.3/5.5: the screen getters must live on Screen.prototype in BOTH worlds.
// Defining them on the window.screen INSTANCE left Object.getOwnPropertyNames(screen)
// returning width/height/... where a real Chrome returns [] - a one-line detector.
// screenReads must also be observable from the page-visible copy, not only from the
// ISOLATED one the page can never read.
const screenSrc = text(join(ROOT, 'content/hooks_screen.js'));
const screenChecks = [
  ['ISOLATED defines screen getters on the prototype',
    /const screenTarget = Object\.getPrototypeOf\(window\.screen\)/.test(screenSrc)],
  ['ISOLATED getters stay non-enumerable',
    /enumerable: false/.test(screenSrc)],
  ['MAIN defines screen getters on the prototype',
    /const screenProto = Object\.getPrototypeOf\(window\.screen\)/.test(injectorSrc)],
  ['MAIN screen getters report the read',
    /bumpStat\('screenReads'\)/.test(injectorSrc)],
  ['ISOLATED screen getters report the read',
    /increment\('screenReads'\)/.test(screenSrc)],
  ['both worlds pin availLeft/availTop to 0',
    /defineGetter\(screenProto, 'availLeft', \(\) => 0\)/.test(injectorSrc) &&
    /defineGetter\(screenProto, 'availTop', \(\) => 0\)/.test(injectorSrc)]
];
const screenFailures = screenChecks.filter(([, pass]) => !pass).map(([label]) => label);
screenFailures.length === 0
  ? ok('screen getters live on the prototype and report their reads')
  : fail('screen getters live on the prototype and report their reads', screenFailures.join(', '));

section('Geolocation world ownership');
// P0 1.1 / P1 4.2: the ISOLATED geolocation installer is a deliberate no-op,
// because the page can never observe an ISOLATED patch of navigator.geolocation
// - the object page script reads is the MAIN-world one. MAIN therefore has to be
// the single owner of the surface, and the two files must not disagree about the
// offset that owner applies.
const geoSrc = text(join(ROOT, 'content/hooks_geolocation.js'));
const schemaSrc = text(join(ROOT, 'core/config-schema.js'));
const geoChecks = [
  ['ISOLATED installer stays a no-op',
    geoSrc.indexOf('navigator.geolocation =') === -1 &&
    geoSrc.indexOf('defineProperty(navigator') === -1],
  ['MAIN world owns the page-visible surface',
    injectorSrc.indexOf('navigator.geolocation.getCurrentPosition = function') !== -1 &&
    injectorSrc.indexOf('navigator.geolocation.watchPosition = function') !== -1],
  ['MAIN reports the read', /bumpStat\('geolocationReads'\)/.test(injectorSrc)],
  ['MAIN fallback matches the schema default',
    injectorSrc.indexOf(': 0.001') !== -1 && schemaSrc.indexOf('noiseLevel: 0.001') !== -1],
  ['MAIN refuses a non-number offset',
    /typeof config\.geolocation\.noiseLevel === 'number'/.test(injectorSrc)],
  ['MAIN clamps the offset group',
    /geolocation: \{ noiseLevel: \[0, 1\] \}/.test(injectorSrc)]
];
const geoFailures = geoChecks.filter(([, pass]) => !pass).map(([label]) => label);
geoFailures.length === 0
  ? ok('geolocation has one owner and one offset policy')
  : fail('geolocation has one owner and one offset policy', geoFailures.join(', '));

section('JavaScript syntax');
const jsFiles = [];
['core', 'content', 'background', 'popup', 'options'].forEach((dir) => {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return;
  readdirSync(abs).forEach((entry) => {
    const full = join(abs, entry);
    if (statSync(full).isFile() && extname(full) === '.js') jsFiles.push(full);
  });
});
let syntaxErrors = 0;
jsFiles.forEach((file) => {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (err) { syntaxErrors++; fail('syntax: ' + file.slice(ROOT.length + 1), String(err.stderr || err.message).split(String.fromCharCode(10))[0]); }
});
if (syntaxErrors === 0) ok('all ' + jsFiles.length + ' runtime files parse');

section('API version floor');
// P2 7.4: minimum_chrome_version was only checked as "a plausible number", never
// against the APIs the runtime actually calls. Bumping an API (storage.session,
// WebGPU, userAgentData) without raising the floor ships code that throws on the
// oldest Chrome the manifest claims to support. Each entry pairs a source token
// with the Chrome release that introduced it; the manifest floor must be at
// least the highest one any runtime file uses.
const API_FLOORS = [
  ['chrome.storage.session', 102],
  ['chrome.storage.sync', 73],
  ['chrome.action.', 88],
  ['chrome.offscreen', 109],
  ['chrome.scripting', 88],
  ['chrome.declarativeNetRequest', 84],
  ['navigator.userAgentData', 90],
  ['navigator.gpu', 113],
  ['GPUAdapter', 113],
  ['AudioWorklet', 66],
  ['visualViewport', 61],
  ['KeyboardLayoutMap', 69],
  ['formatRange', 76]
];
const mcvNum = Number(String((manifest && manifest.minimum_chrome_version) || '0')) || 0;
const floorBreaches = [];
API_FLOORS.forEach(([token, floor]) => {
  const used = jsFiles.some((f) => text(f).indexOf(token) !== -1);
  if (used && mcvNum < floor) floorBreaches.push(token + ' needs ' + floor);
});
floorBreaches.length === 0
  ? ok('minimum_chrome_version covers every API the runtime uses')
  : fail('minimum_chrome_version covers every API the runtime uses', floorBreaches.join(', '));

section('namespace discipline');
// P2: this only listed five exact tokens (fpConfig, fp_, fpHook, fpPRNG, __fp),
// so a bare `fp` identifier - or any other prefixed name such as fpSeed - slipped
// through even though `fp` is the retired namespace. Match the prefix with a word
// boundary instead of enumerating spellings.
const LEGACY_FP = /\bfp[A-Za-z0-9_]*\b|__fp/;
const legacyHits = [];
// Only executable sources are scanned for the retired prefix. README.md and
// AGENTS.md necessarily *name* the retired namespace when they state the rule,
// so scanning prose would make the rule unstateable. Comments inside code are
// stripped for the same reason.
// CRLF matters: with Windows line endings a trailing \r defeats the end-anchor
// used below (there is no `m` flag), so normalize the endings first.
const stripComments = (src) => src
  .replace(/\r\n?/g, String.fromCharCode(10))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(String.fromCharCode(10))
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join(String.fromCharCode(10));
jsFiles.concat([join(ROOT, 'manifest.json')]).forEach((file) => {
  if (!existsSync(file)) return;
  stripComments(text(file)).split(String.fromCharCode(10)).forEach((line, i) => {
    if (LEGACY_FP.test(line)) legacyHits.push(file.slice(ROOT.length + 1) + ':' + (i + 1));
  });
});
legacyHits.length === 0 ? ok('no legacy fp* identifiers') : fail('no legacy fp* identifiers', legacyHits.slice(0, 10).join(', '));

// Architecture section 2: every ss* global must be non-enumerable, otherwise a
// single Object.keys(globalThis) exposes the extension. The list in
// core/stealth.js was a partial enumeration that drifted silently - each helper
// added after it was written stayed enumerable. Derive the names the runtime
// actually assigns and require each to be concealed.
const ASSIGN_RE = /globalThis\.(ss[A-Za-z0-9_]*)\s*=/g;
const assigned = new Set();
jsFiles.forEach((file) => {
  if (file.endsWith('stealth.js')) return;
  const src = text(file);
  let m;
  while ((m = ASSIGN_RE.exec(src)) !== null) assigned.add(m[1]);
});
const stealthSrc = text(join(ROOT, 'core', 'stealth.js'));
const leaked = [];
assigned.forEach((name) => {
  if (stealthSrc.indexOf("'" + name + "'") !== -1) return;
  const at = Math.max(stealthSrc.indexOf('globalThis, "' + name + '"'), stealthSrc.indexOf("globalThis, '" + name + "'"));
  if (at !== -1 && stealthSrc.slice(at, at + 400).indexOf('enumerable: false') !== -1) return;
  leaked.push(name);
});
leaked.length === 0
  ? ok('every ss* global is concealed from enumeration')
  : fail('every ss* global is concealed from enumeration', leaked.join(', '));

section('network guard');
// Project rule: the runtime never talks to the network. Nothing scanned for it,
// so a fetch() or a WebSocket could have landed in a content script unnoticed.
// The rule table below is the same shape used by the lint pass; the URLs in
// comments are ignored by stripping line comments first.
const NETWORK_API = /(^|[^.\w])(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon\s*\(|navigator\.serviceWorker\s*\.register)/;
const stripLineComments = (src) => src.split(String.fromCharCode(10))
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join(String.fromCharCode(10));
const networkHits = [];
jsFiles.forEach((file) => {
  const src = stripLineComments(text(file));
  src.split(String.fromCharCode(10)).forEach((line, i) => {
    if (NETWORK_API.test(line)) networkHits.push(file.slice(ROOT.length + 1) + ':' + (i + 1));
  });
});
networkHits.length === 0
  ? ok('no network APIs in the runtime')
  : fail('no network APIs in the runtime', networkHits.slice(0, 10).join(', '));

section('UI safety');
const innerHtmlHits = jsFiles.filter((f) => (f.indexOf('popup') !== -1 || f.indexOf('options') !== -1) && text(f).indexOf('innerHTML') !== -1);
innerHtmlHits.length === 0 ? ok('no innerHTML in popup/options controllers') : fail('no innerHTML in popup/options', innerHtmlHits.join(', '));

section('per-site allowlist');
// Feature 7.6: ss_site_settings was named in the storage contract from the
// start, but nothing in the UI ever wrote it - the documented "pause protection
// on this site" flow simply did not exist, and no gate would have noticed
// because the key itself was legal. The options page now owns the list, so pin
// both halves: the markup the handler binds to, and the fact that it stores a
// normalized ORIGIN rather than the raw typed string (the runtime matches by
// page origin, so `example.com/` or `http://example.com` would never match).
const optionsHtmlSrc = text(join(ROOT, 'options', 'options.html'));
const optionsJsSrc = text(join(ROOT, 'options', 'options.js'));
const siteChecks = [
  ['options markup ships the site list and the add control',
    optionsHtmlSrc.includes('id="siteList"') &&
    optionsHtmlSrc.includes('id="newSiteInput"') &&
    optionsHtmlSrc.includes('id="addSiteBtn"')],
  ['the add handler normalizes the typed value to an origin',
    optionsJsSrc.includes('new URL(') && optionsJsSrc.includes('.origin')],
  ['the add handler writes a disabled entry into ss_site_settings',
    optionsJsSrc.includes('ss_site_settings') && /enabled:\s*false/.test(optionsJsSrc)],
  ['the list offers a resume path that clears the entry',
    /delete current\[origin\]/.test(optionsJsSrc)]
];
const siteFailures = siteChecks.filter(([, pass]) => !pass).map(([label]) => label);
siteFailures.length === 0
  ? ok('per-site allowlist UI writes and clears ss_site_settings')
  : fail('per-site allowlist UI writes and clears ss_site_settings', siteFailures.join(', '));

section('storage contract');
const ALLOWED_KEYS = new Set(['ssConfig', 'ss_salt', 'ss_stats', 'ss_site_settings', 'ss_rotation_info', 'ss_diagnostics']);
// P2: this used to look only at chrome.storage.local with single-quoted
// literals. A stray key written to .sync or .session broke the same contract,
// and core/salts.js writes its keys with double quotes, so the old check never
// saw them at all. Scan every area and both quote styles.
const AREA_RE = /chrome\.storage\.(local|session|sync)/;
const KEY_TOKEN_RE = /'([^']*)'|"([^"]*)"/g;
// Quoted tokens that appear on a storage line but are provably not keys:
// the `typeof chrome !== "undefined"` guards and the area names themselves.
const NOT_A_KEY = new Set(['undefined', 'function', 'object', 'boolean', 'string', 'number', 'symbol', 'local', 'session', 'sync', 'managed']);
// The scan lives in a function so the positive control below can exercise it
// with known-bad input. A gate that cannot fail on a seeded violation is not a
// gate, it is decoration.
function strayKeysIn (src) {
  const found = [];
  const lines = src.split(String.fromCharCode(10));
  lines.forEach((line, li) => {
    if (!AREA_RE.test(line)) return;
    // P2 (multi-line calls): a storage call split across lines put the area on
    // one line and the key literal on the next, so the old per-line skip never
    // examined the literal at all. Join a short forward window from each
    // chrome.storage.* reference before scanning it, so the key is seen even
    // when it does not share a line with the area token.
    const window = lines.slice(li, li + 4).join(String.fromCharCode(10));
    let m;
    KEY_TOKEN_RE.lastIndex = 0;
    while ((m = KEY_TOKEN_RE.exec(window)) !== null) {
      const key = m[1] !== undefined ? m[1] : m[2];
      // Skip empty strings, prose, and anything path- or selector-shaped: the
      // only literals that can be storage keys are bare identifiers.
      if (!key || /[\s/.#]/.test(key)) continue;
      // A literal that is the right-hand side of an equality/typeof test is not
      // a storage key (e.g. the "undefined" in `typeof chrome !== "undefined"`).
      if (NOT_A_KEY.has(key)) continue;
      if (/(===|!==|typeof\s+)$/.test(window.slice(0, m.index))) continue;
      if (!ALLOWED_KEYS.has(key)) found.push(key);
    }
  });
  return found;
}

const strayKeys = [];
jsFiles.forEach((file) => {
  strayKeysIn(text(file)).forEach((key) => {
    strayKeys.push(file.slice(ROOT.length + 1) + ' -> ' + key);
  });
});
strayKeys.length === 0 ? ok('every storage key matches the contract') : fail('storage key contract', strayKeys.slice(0, 10).join(', '));

// Positive control: both the same-line form and the multi-line form must be
// caught. The multi-line case is what the previous line-based scan missed.
const controlSameLine = strayKeysIn('chrome.storage.local.get(["ss_typo"], cb);').indexOf('ss_typo') !== -1;
const controlMultiLine = strayKeysIn('chrome.storage.local.get(\n  ["ss_typo"],\n  cb\n);').indexOf('ss_typo') !== -1;
controlSameLine && controlMultiLine
  ? ok('the storage scan catches same-line and multi-line stray keys')
  : fail('the storage scan catches same-line and multi-line stray keys',
    'same=' + controlSameLine + ' multi=' + controlMultiLine);

section('project files');
// SECURITY.md and PRIVACY.md are part of the contract, not optional docs: the
// extension touches every page the user visits and stores data locally, so a
// missing policy file must fail the gate rather than silently disappear.
['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE', 'CHANGELOG.md', 'BUILD.md', 'SECURITY.md', 'PRIVACY.md', 'package.json', '.gitignore'].forEach((file) => {
  existsSync(join(ROOT, file)) ? ok(file + ' present') : fail(file + ' present');
});

section('branding');
if (existsSync(join(ROOT, 'README.md'))) {
  const readme = text(join(ROOT, 'README.md'));
  readme.indexOf('# ShapeShift') !== -1 ? ok('README titled ShapeShift') : fail('README titled ShapeShift');
  readme.indexOf('dinhdidaudo/shapeshift') !== -1 ? ok('README links the ShapeShift repo') : fail('README links the ShapeShift repo');
  // The preset names are a user-visible contract: options.html ships the
  // buttons, options.js maps data-preset -> patch, and the README documents the
  // same three levels. The README once still advertised the retired
  // balanced/strict/compat names after the UI moved to light/balanced/maximum,
  // so the docs described profiles that did not exist. Derive the expected
  // labels from the buttons and require each one in the README.
  if (existsSync(join(ROOT, 'options', 'options.html'))) {
    const presetNames = (text(join(ROOT, 'options', 'options.html')).match(/data-preset="([a-z]+)"/g) || [])
      .map((m) => m.slice(13, -1));
    const labels = { light: 'Light', balanced: 'Balanced', maximum: 'Maximum' };
    const missing = presetNames.filter((n) => !new RegExp('\\*\\*' + (labels[n] || n) + '\\*\\*').test(readme));
    presetNames.length >= 3 && missing.length === 0
      ? ok('README documents every preset the options page ships')
      : fail('README documents every preset the options page ships', missing.join(', ') || 'no presets found');
    // Retired names must not survive in the docs, exactly like the retired
    // palette tokens in the brand gate.
    const retiredPresets = ['Compatibility', 'Strict'];
    const stale = retiredPresets.filter((n) => new RegExp('\\*\\*' + n + '\\*\\*').test(readme));
    stale.length === 0
      ? ok('README drops the retired preset names')
      : fail('README drops the retired preset names', stale.join(', '));
  }
}

section('brand unification');
// The mark has exactly one definition: scripts/brand-spec.mjs. The PNG icons
// and images/logo.svg are regenerated from it, and the inline HTML copies must
// carry the same geometry and the same aurora stops. This gate exists because
// the popup once shipped #46e3d0/#7c8cff at the old coordinates while the
// options page shipped the new ones, so the two headers visibly disagreed.
const brand = await import('./brand-spec.mjs');
const parts = brand.markParts();
const geometry = [
  parts.transform,
  parts.rect,
  parts.circle,
  `stroke-width="${brand.MARK.stroke}"`
];
const surfaces = [
  ['popup/popup.html', 'ssMarkPopup', 'ssRingPopup'],
  ['options/options.html', 'ssMarkOptions', 'ssRingOptions']
];
const brandFails = [];
surfaces.forEach(([rel, markId, ringId]) => {
  const html = text(join(ROOT, rel));
  geometry.forEach((frag) => { if (!html.includes(frag)) brandFails.push(rel + ' geometry ' + frag); });
  brand.AURORA.forEach((stop) => {
    const tag = `offset="${stop.offset}" stop-color="${stop.color}"`;
    if (!html.includes(tag)) brandFails.push(rel + ' stop ' + stop.color);
  });
  [markId, ringId].forEach((id) => {
    if (!html.includes(`id="${id}"`)) brandFails.push(rel + ' gradient ' + id);
  });
});
// The CSS must reference the ring gradients the HTML defines.
[['popup/popup.css', 'ssRingPopup'], ['options/options.css', 'ssRingOptions']].forEach(([rel, id]) => {
  if (!text(join(ROOT, rel)).includes(`url(#${id})`)) brandFails.push(rel + ' url(#' + id + ')');
});
// Retired concepts, palettes and geometry must not come back.
const retired = ['#46e3d0', '#7c8cff', 'x="5.2"', 'width="21.6"', 'x="12.6"', 'x="4.4"', 'x="13.4"', 'rx="7"', 'rx="3.6"'];
['popup/popup.html', 'options/options.html'].forEach((rel) => {
  const html = text(join(ROOT, rel));
  retired.forEach((needle) => { if (html.includes(needle)) brandFails.push(rel + ' retired ' + needle); });
});
brandFails.length === 0
  ? ok('popup/options/rings share the canonical mark and aurora')
  : fail('brand mark is unified', brandFails.slice(0, 8).join(', '));
existsSync(join(ROOT, 'images', 'logo.svg')) ? ok('logo master present') : fail('logo master present');
// generate-icons.mjs writes a 256px store/readme master that manifest.json does
// not reference, so no other check would notice if it went missing - and the
// numbered toolbar sizes are what the manifest loads.
existsSync(join(ROOT, 'images', 'icon.png')) ? ok('icon master present') : fail('icon master present');
const missingIcons = ['16', '32', '48', '128'].filter((size) => !existsSync(join(ROOT, 'images', 'icon' + size + '.png')));
missingIcons.length === 0
  ? ok('all four toolbar icon sizes present')
  : fail('all four toolbar icon sizes present', missingIcons.join(', '));
existsSync(join(ROOT, 'BRAND.md')) ? ok('BRAND.md present') : fail('BRAND.md present');

section('scripts tooling');
// Every helper in scripts/ resolves the repo root through fileURLToPath. A bare
// `URL.pathname` is percent-encoded and keeps the Windows drive slash, so a
// checkout under "C:/Users/My Name/..." (or any path with a space) produced a
// ROOT no fs call could open - and because these are the tools that rewrite and
// verify the tree, the failure looked like a permissions problem, not a bug.
// Pin the form so it cannot regress in one script while the others stay fixed.
const scriptFiles = readdirSync(join(ROOT, 'scripts'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => 'scripts/' + f);
// The pattern is assembled at runtime and comments are stripped first: verify.mjs
// itself has to mention the banned form to explain the rule, and a literal here
// would otherwise make the check fail on its own source.
const BARE_PATHNAME = new RegExp('\\.' + 'path' + 'name' + '\\b');
const pathnameHits = scriptFiles.filter((rel) => {
  if (rel === 'scripts/verify.mjs') return false;
  return stripLineComments(text(join(ROOT, rel)))
    .split(String.fromCharCode(10))
    .some((line) => BARE_PATHNAME.test(line));
});
pathnameHits.length === 0
  ? ok('scripts resolve ROOT without URL.pathname')
  : fail('scripts resolve ROOT without URL.pathname', pathnameHits.join(', '));
const rootResolver = scriptFiles.filter((rel) => /fileURLToPath\s*\(/.test(text(join(ROOT, rel))));
rootResolver.length >= 3
  ? ok('every root-resolving script uses fileURLToPath')
  : fail('every root-resolving script uses fileURLToPath', rootResolver.join(', ') || 'none found');

section('dist freshness');
// dist/ is a committed copy of the runtime tree. Nothing compared it against
// the sources, so a source edit could ship while dist/ silently kept the old
// behaviour. When dist/ exists, every runtime file must be byte-identical
// there. A missing dist/ is reported as skipped rather than failed, because
// loading the extension unpacked does not need build output.
if (SKIP_DIST) {
  ok('dist/ freshness skipped (--no-dist)');
} else if (!existsSync(join(ROOT, 'dist'))) {
  ok('dist/ not built (nothing to compare)');
} else {
  const distDirs = ['core', 'content', 'background', 'popup', 'options'];
  const drift = [];
  const compareDist = (rel) => {
    const distPath = join(ROOT, 'dist', rel);
    if (!existsSync(distPath)) { drift.push(rel + ' missing'); return; }
    if (text(join(ROOT, rel)) !== text(distPath)) drift.push(rel + ' stale');
  };
  distDirs.forEach((dir) => {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return;
    readdirSync(abs).forEach((entry) => {
      const full = join(abs, entry);
      if (!statSync(full).isFile()) return;
      if (['.js', '.css', '.html', '.json'].indexOf(extname(full)) === -1) return;
      compareDist(dir + '/' + entry);
    });
  });
  compareDist('manifest.json');
  drift.length === 0
    ? ok('dist/ matches the runtime sources')
    : fail('dist/ matches the runtime sources', drift.slice(0, 8).join(', '));
}

// --lint adds the static checks that a plain `verify` run deliberately keeps
// out: they are style/hazard rules, not structural contract checks. Before
// this section existed the flag only changed the final banner.
if (LINT) {
  section('lint rules');
  // Only the shipped runtime dirs are scanned: scripts/ holds the tooling
  // itself, and verify.mjs necessarily contains the rule patterns as literals
  // (scanning it would make every lint run report its own rule table).
  const RUNTIME = jsFiles.filter((f) => f.indexOf(join(ROOT, 'scripts')) !== 0);
  const RULES = [
    [/Math\.random\s*\(/, 'Math.random() in a seed-bearing path'],
    [/\beval\s*\(/, 'eval()'],
    [/new Function\s*\(/, 'new Function()'],
    [/document\.write\s*\(/, 'document.write()'],
    [/\bdebugger\b/, 'debugger statement'],
    [/\bTODO\b|\bFIXME\b/, 'TODO/FIXME left in shipped code']
  ];
  const lintHits = [];
  RUNTIME.forEach((file) => {
    const rel = file.slice(ROOT.length + 1);
    text(file).split(String.fromCharCode(10)).forEach((line, i) => {
      RULES.forEach(([re, label]) => {
        if (re.test(line)) lintHits.push(rel + ':' + (i + 1) + ' ' + label);
      });
    });
  });
  lintHits.length === 0 ? ok('no lint hazards in ' + RUNTIME.length + ' files') : fail('lint hazards', lintHits.slice(0, 10).join(' | '));
}

console.log('');
console.log((failures === 0 ? 'PASS' : 'FAIL') + ' - ' + (checks - failures) + '/' + checks + ' checks passed' + (LINT ? ' (lint mode)' : ''));
process.exit(failures === 0 ? 0 : 1);
