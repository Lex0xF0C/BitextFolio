import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function collectFiles(dirPath, extensions) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function relPath(absPath) {
  return path.relative(ROOT_DIR, absPath).split(path.sep).join('/');
}

function stripJsCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

const INDEX_HTML_PATH = path.join(ROOT_DIR, 'index.html');
const JS_FILES = collectFiles(path.join(ROOT_DIR, 'js'), ['.js']);
const CORE_FILES = collectFiles(path.join(ROOT_DIR, 'js', 'core'), ['.js']);
const STYLE_FILES = collectFiles(path.join(ROOT_DIR, 'styles'), ['.css']);
const WEB_ASSET_FILES = [INDEX_HTML_PATH, ...JS_FILES, ...STYLE_FILES];

test('P4: Zero external network APIs or non-allowlisted HTTP(S) URLs', () => {
  const forbiddenNetwork = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b|sendBeacon\s*\(/;
  const httpUrlPattern = /https?:\/\/[^\s'"`<>)]+/g;
  const allowlistedUrls = new Set(['http://www.w3.org/2000/svg']);

  for (const file of WEB_ASSET_FILES) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = relPath(file);
    assert.equal(
      forbiddenNetwork.test(content),
      false,
      `Forbidden network API pattern found in ${rel}`,
    );

    const urls = content.match(httpUrlPattern) || [];
    for (const url of urls) {
      assert.ok(
        allowlistedUrls.has(url),
        `Non-allowlisted external URL "${url}" found in ${rel}`,
      );
    }
  }

  const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.match(indexHtml, /default-src\s+'self'/);
  assert.match(indexHtml, /connect-src\s+'none'/);
  assert.match(indexHtml, /script-src\s+'self'/);
  assert.match(indexHtml, /style-src\s+'self'/);
  assert.match(indexHtml, /object-src\s+'none'/);
  assert.match(indexHtml, /form-action\s+'none'/);
});

test('P5: CSP-safe DOM construction and CSS loading', () => {
  const unsafeDomAllowlist = new Set(['js/ui/render-helpers.js']);
  const unsafeDomPattern = /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b|\beval\s*\(|\bnew\s+Function\b/;
  const unsafeAttrOrDynamicImport = /setAttribute\s*\(\s*['"](?:on|style)|\bimport\s*\(/;
  const cssImportInJs = /(?:import\s+[^;]*\.css['"]|import\s*['"][^'"]*\.css['"])/;

  for (const file of [INDEX_HTML_PATH, ...JS_FILES]) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = relPath(file);

    if (unsafeDomPattern.test(content)) {
      if (unsafeDomAllowlist.has(rel)) {
        // Only the header comment in render-helpers.js may mention innerHTML
        const withoutHeaderComment = content.replace(/^\/\*[\s\S]*?\*\//, '');
        assert.equal(
          unsafeDomPattern.test(withoutHeaderComment),
          false,
          `Unsafe DOM API found outside allowlisted header comment in ${rel}`,
        );
      } else {
        assert.fail(`Forbidden unsafe DOM/eval pattern found in ${rel}`);
      }
    }

    assert.equal(
      unsafeAttrOrDynamicImport.test(content),
      false,
      `Forbidden setAttribute('on'/'style') or dynamic import() found in ${rel}`,
    );

    if (file.endsWith('.js')) {
      assert.equal(
        cssImportInJs.test(content),
        false,
        `Forbidden CSS import inside JS module ${rel}`,
      );
    }
  }

  const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.equal(/<style[\s>]/i.test(indexHtml), false, 'Inline <style> is forbidden in index.html');
  assert.equal(/\sstyle\s*=/i.test(indexHtml), false, 'Inline style= attribute is forbidden in index.html');
  assert.equal(/\son[a-z]+\s*=/i.test(indexHtml), false, 'Inline on*= attribute is forbidden in index.html');
  const scriptTags = indexHtml.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  assert.ok(scriptTags.length >= 1, 'index.html must load main ES module');
  for (const tag of scriptTags) {
    assert.match(tag, /\ssrc\s*=\s*['"]\.\/[^'"]+['"]/, 'Inline <script> without relative src is forbidden');
    assert.match(tag, /^<script\b[^>]*><\/script>$/i, 'Script tag must have empty body');
  }
});

test('P6: Zero-build static delivery with .nojekyll and relative paths', () => {
  assert.equal(
    fs.existsSync(path.join(ROOT_DIR, '.nojekyll')),
    true,
    '.nojekyll must exist at repository root for GitHub Pages',
  );

  const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.match(indexHtml, /<link\s+rel="stylesheet"\s+href="\.\/styles\/app\.css"\s*\/?>/);
  assert.match(indexHtml, /<script\s+type="module"\s+src="\.\/js\/main\.js"><\/script>/);
  assert.equal(/(?:src|href)\s*=\s*['"]\/(?!\/)/.test(indexHtml), false, 'Root-absolute asset paths break GitHub Pages subpaths');

  for (const file of JS_FILES) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = relPath(file);
    assert.equal(
      /\bfrom\s+['"]\/[^'"]+['"]/.test(content),
      false,
      `Root-absolute module import found in ${rel}`,
    );
  }
});

test('Layer boundary: js/core/ is DOM-free and browser-API-free', () => {
  const forbiddenGlobals = /\b(?:window|document|localStorage|sessionStorage|indexedDB|navigator|HTMLElement|NodeFilter)\b/;
  for (const file of CORE_FILES) {
    const content = fs.readFileSync(file, 'utf8');
    const codeOnly = stripJsCommentsAndStrings(content);
    const rel = relPath(file);
    assert.equal(
      forbiddenGlobals.test(codeOnly),
      false,
      `DOM/browser global reference found in core module ${rel}`,
    );
  }
});

test('P1 invariant: No function in js/core/ automatically sets status to verified', () => {
  const autoVerifyPattern = /(?:status\s*:\s*['"]verified['"]|\.status\s*=\s*['"]verified['"])/;
  for (const file of CORE_FILES) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = relPath(file);
    assert.equal(
      autoVerifyPattern.test(content),
      false,
      `Automatic verified status assignment found in core module ${rel}`,
    );
  }
});

test('P2 invariant: Every hint in js/core/hints.js records code, level, title, detail, and supports dismissal', () => {
  const hintsSource = fs.readFileSync(path.join(ROOT_DIR, 'js', 'core', 'hints.js'), 'utf8');
  const pushHintMatches = [...hintsSource.matchAll(/pushHint\s*\(\s*([^)]+)\)/g)];
  assert.ok(pushHintMatches.length >= 6, 'Expected deterministic hint rules in js/core/hints.js');
  for (const m of pushHintMatches) {
    const args = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    assert.ok(args.length >= 4, `pushHint call must provide code, level, title, and detail: ${m[0]}`);
  }
  assert.match(hintsSource, /dismissedHints/);
});
