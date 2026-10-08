// ShapeShift - structural + syntax verification for the MV3 extension.
// Usage: node scripts/verify.mjs [--lint]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LINT = process.argv.includes('--lint');
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
  manifest.author === 'dinhdidaudo' ? ok('author is dinhdidaudo') : fail('author is dinhdidaudo');
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
      // LOCALE_MSG is declared inside the `if (manifest)` block above and is not
      // visible here, so re-declare the placeholder shape locally.
      const LOCALE_MSG = /^__MSG_[A-Za-z0-9_]+__$/;
      const placeholders = [manifest.name, manifest.short_name, manifest.description]
        .filter((v) => typeof v === 'string' && LOCALE_PLACEHOLDER.test(v))
        .map((v) => v.slice(6, -2));
      const missingMsgs = placeholders.filter((k) => !catalog[k] || typeof catalog[k].message !== 'string');
      missingMsgs.length === 0
        ? ok('every __MSG_*__ placeholder resolves in the catalog')
        : fail('every __MSG_*__ placeholder resolves in the catalog', missingMsgs.join(', '));
    }
  }
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
const nonceChecks = [
  ['injector publishes a nonce', injectorSrc.includes('SS_PAGE_WORLD_READY') && injectorSrc.includes('nonce: ssNonce')],
  ['injector refuses a message without the nonce', /event\.data\.nonce !== ssNonce/.test(injectorSrc)],
  ['injector answers SS_PAGE_WORLD_HELLO', injectorSrc.includes('SS_PAGE_WORLD_HELLO')],
  ['bootstrap listens for SS_PAGE_WORLD_READY', bootstrapSrc.includes("'SS_PAGE_WORLD_READY'")],
  ['bootstrap echoes the nonce', bootstrapSrc.includes('nonce: pageNonce')],
  ['bootstrap asks for the nonce', bootstrapSrc.includes('SS_PAGE_WORLD_HELLO')]
];
const nonceFailures = nonceChecks.filter(([, pass]) => !pass).map(([label]) => label);
nonceFailures.length === 0
  ? ok('nonce handshake is wired on both sides')
  : fail('nonce handshake is wired on both sides', nonceFailures.join(', '));

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

section('namespace discipline');
const legacyHits = [];
jsFiles.concat([join(ROOT, 'manifest.json'), join(ROOT, 'README.md'), join(ROOT, 'AGENTS.md')]).forEach((file) => {
  if (!existsSync(file)) return;
  text(file).split(String.fromCharCode(10)).forEach((line, i) => {
    const bad = line.indexOf('fpConfig') !== -1 || line.indexOf('fp_') !== -1 || line.indexOf('fpHook') !== -1 || line.indexOf('fpPRNG') !== -1 || line.indexOf('__fp') !== -1;
    if (bad) legacyHits.push(file.slice(ROOT.length + 1) + ':' + (i + 1));
  });
});
legacyHits.length === 0 ? ok('no legacy fp* identifiers') : fail('no legacy fp* identifiers', legacyHits.slice(0, 10).join(', '));

section('UI safety');
const innerHtmlHits = jsFiles.filter((f) => (f.indexOf('popup') !== -1 || f.indexOf('options') !== -1) && text(f).indexOf('innerHTML') !== -1);
innerHtmlHits.length === 0 ? ok('no innerHTML in popup/options controllers') : fail('no innerHTML in popup/options', innerHtmlHits.join(', '));

section('storage contract');
const ALLOWED_KEYS = new Set(['ssConfig', 'ss_salt', 'ss_stats', 'ss_site_settings', 'ss_rotation_info']);
const strayKeys = [];
jsFiles.forEach((file) => {
  const lines = text(file).split(String.fromCharCode(10));
  lines.forEach((line) => {
    if (line.indexOf('chrome.storage.local') === -1) return;
    const quoted = line.match(/'[^']+'/g) || [];
    quoted.forEach((tok) => {
      const key = tok.slice(1, -1);
      if (key.indexOf(' ') !== -1 || key.length === 0) return;
      if (!ALLOWED_KEYS.has(key)) strayKeys.push(file.slice(ROOT.length + 1) + ' -> ' + key);
    });
  });
});
strayKeys.length === 0 ? ok('every storage key matches the contract') : fail('storage key contract', strayKeys.slice(0, 10).join(', '));

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
      // The unit-test harness legitimately exercises `new Function` to load
      // the core IIFEs into a sandbox, so it is exempt from that one rule.
      RULES.forEach(([re, label]) => {
        if (rel.indexOf('scripts' + String.fromCharCode(92)) === 0 && label === 'new Function()') return;
        if (rel.indexOf('scripts/') === 0 && label === 'new Function()') return;
        if (re.test(line)) lintHits.push(rel + ':' + (i + 1) + ' ' + label);
      });
    });
  });
  lintHits.length === 0 ? ok('no lint hazards in ' + RUNTIME.length + ' files') : fail('lint hazards', lintHits.slice(0, 10).join(' | '));
}

console.log('');
console.log((failures === 0 ? 'PASS' : 'FAIL') + ' - ' + (checks - failures) + '/' + checks + ' checks passed' + (LINT ? ' (lint mode)' : ''));
process.exit(failures === 0 ? 0 : 1);
