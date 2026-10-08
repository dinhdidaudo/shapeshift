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
  manifest.name === 'ShapeShift' ? ok('name is ShapeShift') : fail('name is ShapeShift', String(manifest.name));
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
  }
}

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
legacyHits.length === 0 ? ok('no legacy fp* identifiers outside refers/') : fail('no legacy fp* identifiers', legacyHits.slice(0, 10).join(', '));

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
['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE', 'CHANGELOG.md', 'BUILD.md', 'package.json', '.gitignore'].forEach((file) => {
  existsSync(join(ROOT, file)) ? ok(file + ' present') : fail(file + ' present');
});

section('branding');
if (existsSync(join(ROOT, 'README.md'))) {
  const readme = text(join(ROOT, 'README.md'));
  readme.indexOf('# ShapeShift') !== -1 ? ok('README titled ShapeShift') : fail('README titled ShapeShift');
  readme.indexOf('dinhdidaudo/shapeshift') !== -1 ? ok('README links the ShapeShift repo') : fail('README links the ShapeShift repo');
}

console.log('');
console.log((failures === 0 ? 'PASS' : 'FAIL') + ' - ' + (checks - failures) + '/' + checks + ' checks passed' + (LINT ? ' (lint mode)' : ''));
process.exit(failures === 0 ? 0 : 1);
