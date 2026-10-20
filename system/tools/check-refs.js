#!/usr/bin/env node
"use strict";
// check-refs.js : finds identifiers that are used but never declared
// (the "ReferenceError: X is not defined" class of bug) in every .js file
// under system/ and in every inline <script> of every .html file.
//
//   node system/tools/check-refs.js     (run from the repo root; exits 1 if it finds any)
//
// Needs `acorn` (npm i -D acorn). Top-level declarations in any file count as
// globals for all the others, because classic <script> tags share one scope.
const fs = require("fs");
const path = require("path");
let acorn;
try { acorn = require("acorn"); } catch (_) {
  try { acorn = require(path.join(process.env.ACORN_DIR || "", "")); } catch (e) {
    console.error("acorn is missing: run `npm i -D acorn` first."); process.exit(2);
  }
}

const ROOT = process.argv[2] || "system";
const SKIP_DIRS = new Set(["vendor", "node_modules", ".git"]);
const SKIP_FILES = new Set(["check-refs.js"]);

const BROWSER = `window document self globalThis navigator location history screen localStorage sessionStorage indexedDB
console fetch Request Response Headers XMLHttpRequest FormData URL URLSearchParams Blob File FileReader FileList
setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback
queueMicrotask structuredClone atob btoa alert confirm prompt open close print postMessage matchMedia getComputedStyle
Image Audio Option Worker SharedWorker ServiceWorker BroadcastChannel MessageChannel WebSocket EventSource Notification
Event CustomEvent KeyboardEvent MouseEvent PointerEvent TouchEvent DragEvent ClipboardEvent InputEvent FocusEvent WheelEvent StorageEvent MessageEvent ErrorEvent PromiseRejectionEvent
Node Element HTMLElement HTMLInputElement HTMLImageElement HTMLCanvasElement HTMLAnchorElement HTMLVideoElement HTMLAudioElement HTMLIFrameElement HTMLTextAreaElement HTMLSelectElement HTMLButtonElement SVGElement DocumentFragment ShadowRoot Range Selection
MutationObserver IntersectionObserver ResizeObserver PerformanceObserver performance Performance
AbortController AbortSignal TextEncoder TextDecoder DOMParser XMLSerializer DOMException DOMRect
CanvasRenderingContext2D OffscreenCanvas ImageData ImageBitmap createImageBitmap Path2D
AudioContext webkitAudioContext OfflineAudioContext MediaRecorder MediaStream MediaSource
crypto Crypto SubtleCrypto caches CacheStorage Cache indexedDB IDBKeyRange customElements CSS CSSStyleSheet
screenX screenY innerWidth innerHeight outerWidth outerHeight scrollX scrollY pageXOffset pageYOffset devicePixelRatio
scrollTo scrollBy scroll focus blur stop find getSelection speechSynthesis SpeechSynthesisUtterance
parent top frames opener name status length event onerror onload
CompressionStream DecompressionStream ReadableStream WritableStream TransformStream Intl WebAssembly
isSecureContext origin trustedTypes visualViewport showOpenFilePicker showSaveFilePicker
define module exports require`.split(/\s+/);
// Libraries loaded from a <script> or lazily at runtime (add yours here).
const LIBS = "Cropper qrcode QRCode JSZip Crate dataLayer adsbygoogle gtag twemoji Sortable".split(" ");
const JSGLOBALS = Object.getOwnPropertyNames(globalThis);
const KNOWN = new Set([...BROWSER, ...LIBS, ...JSGLOBALS, "arguments", "undefined", "NaN", "Infinity"]);

/* ---------- gather files ---------- */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (SKIP_FILES.has(e.name)) continue;
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(ROOT, []);
if (fs.existsSync("index.html")) files.push("index.html");
const units = [];   // { file, code, line0 }
for (const f of files) {
  if (/\.js$/.test(f)) units.push({ file: f, code: fs.readFileSync(f, "utf8"), line0: 0 });
  else if (/\.html?$/.test(f)) {
    const src = fs.readFileSync(f, "utf8");
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(src))) {
      const attrs = m[1];
      if (/\bsrc\s*=/.test(attrs)) continue;
      if (/type\s*=\s*["']?(?!module|text\/javascript|application\/javascript)/i.test(attrs) && /type\s*=/.test(attrs)) continue;
      const line0 = src.slice(0, m.index + m[0].indexOf(">") + 1).split("\n").length - 1;
      units.push({ file: f, code: m[2], line0, module: /type\s*=\s*["']?module/i.test(attrs) });
    }
  }
}

/* ---------- parse ---------- */
const parsed = [];
let parseErrors = 0;
for (const u of units) {
  try {
    u.ast = acorn.parse(u.code, { ecmaVersion: "latest", sourceType: u.module ? "module" : "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true });
    parsed.push(u);
  } catch (e) {
    parseErrors++;
    console.log(`PARSE ERROR  ${u.file}:${(e.loc ? e.loc.line : 0) + u.line0}  ${e.message}`);
  }
}

/* ---------- scope analysis ---------- */
class Scope {
  constructor(parent, fn) { this.parent = parent; this.fn = fn; this.names = new Set(); }
  has(n) { for (let s = this; s; s = s.parent) if (s.names.has(n)) return true; return false; }
}
function patternNames(p, out) {
  if (!p) return out;
  switch (p.type) {
    case "Identifier": out.push(p.name); break;
    case "ObjectPattern": p.properties.forEach((x) => patternNames(x.type === "RestElement" ? x.argument : x.value, out)); break;
    case "ArrayPattern": p.elements.forEach((x) => patternNames(x, out)); break;
    case "RestElement": patternNames(p.argument, out); break;
    case "AssignmentPattern": patternNames(p.left, out); break;
  }
  return out;
}
const isBrowserClass = (n) => /^(CSS|HTML|SVG|MathML|RTC|Audio|IDB|Web|Media|Speech|Gamepad|XR|GPU)[A-Za-z]*$/.test(n);
const isFn = (n) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";
function kids(n) {
  const out = [];
  for (const k of Object.keys(n)) {
    if (k === "loc" || k === "start" || k === "end" || k === "type") continue;
    const v = n[k];
    if (Array.isArray(v)) v.forEach((x) => x && typeof x.type === "string" && out.push([k, x]));
    else if (v && typeof v.type === "string") out.push([k, v]);
  }
  return out;
}
function collectVars(n, out) {          // var + function declarations hoisted to the function scope
  if (n.type === "VariableDeclaration" && n.kind === "var") n.declarations.forEach((d) => patternNames(d.id, out));
  if (n.type === "FunctionDeclaration") { out.push(n.id.name); return; }
  if (isFn(n) || n.type === "ClassBody") return;
  for (const [, c] of kids(n)) collectVars(c, out);
}
function declareBlock(stmts, scope) {   // let/const/class/function directly in this block
  for (const s of stmts) {
    if (s.type === "VariableDeclaration" && s.kind !== "var") s.declarations.forEach((d) => patternNames(d.id, []).forEach((x) => scope.names.add(x)));
    else if (s.type === "ClassDeclaration" && s.id) scope.names.add(s.id.name);
    else if (s.type === "FunctionDeclaration") scope.names.add(s.id.name);
    else if (s.type === "ExportNamedDeclaration" && s.declaration) declareBlock([s.declaration], scope);
  }
}

function analyse(unit, globalsSet, report) {
  const ref = (name, node, scope) => {
    if (scope.has(name) || globalsSet.has(name) || KNOWN.has(name) || isBrowserClass(name)) return;
    report.push({ file: unit.file, line: node.loc.start.line + unit.line0, name });
  };
  function visit(n, scope, parent, key) {
    if (!n) return;
    switch (n.type) {
      case "Identifier": ref(n.name, n, scope); return;
      case "Program": {
        const s = scope; const pv = []; n.body.forEach((c) => collectVars(c, pv)); pv.forEach((x) => s.names.add(x));
        declareBlock(n.body, s);
        n.body.forEach((c) => visit(c, s, n));
        return;
      }
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": {
        const s = new Scope(scope, true);
        if (n.type === "FunctionExpression" && n.id) s.names.add(n.id.name);
        n.params.forEach((p) => patternNames(p, []).forEach((x) => s.names.add(x)));
        const vars = []; if (n.body.type === "BlockStatement") n.body.body.forEach((c) => collectVars(c, vars));
        vars.forEach((x) => s.names.add(x));
        s.names.add("arguments");
        n.params.forEach((p) => visitPattern(p, s));
        if (n.body.type === "BlockStatement") { declareBlock(n.body.body, s); n.body.body.forEach((c) => visit(c, s, n.body)); }
        else visit(n.body, s, n);
        return;
      }
      case "BlockStatement": case "StaticBlock": {
        const s = new Scope(scope, false); const body = n.body;
        declareBlock(body, s); body.forEach((c) => visit(c, s, n)); return;
      }
      case "SwitchStatement": {
        visit(n.discriminant, scope, n);
        const s = new Scope(scope, false);
        n.cases.forEach((c) => declareBlock(c.consequent, s));
        n.cases.forEach((c) => { if (c.test) visit(c.test, s, c); c.consequent.forEach((x) => visit(x, s, c)); });
        return;
      }
      case "ForStatement": case "ForInStatement": case "ForOfStatement": {
        const s = new Scope(scope, false);
        const init = n.type === "ForStatement" ? n.init : n.left;
        if (init && init.type === "VariableDeclaration") init.declarations.forEach((d) => patternNames(d.id, []).forEach((x) => s.names.add(x)));
        kids(n).forEach(([k, c]) => visit(c, s, n, k));
        return;
      }
      case "CatchClause": {
        const s = new Scope(scope, false);
        if (n.param) patternNames(n.param, []).forEach((x) => s.names.add(x));
        if (n.param) visitPattern(n.param, s);
        visit(n.body, s, n); return;
      }
      case "ClassDeclaration": case "ClassExpression": {
        const s = new Scope(scope, false); if (n.id) s.names.add(n.id.name);
        if (n.superClass) visit(n.superClass, s, n);
        n.body.body.forEach((m) => visitMember(m, s)); return;
      }
      case "VariableDeclaration":
        n.declarations.forEach((d) => { visitPattern(d.id, scope); if (d.init) visit(d.init, scope, d); });
        return;
      case "MemberExpression":
        visit(n.object, scope, n); if (n.computed) visit(n.property, scope, n); return;
      case "Property":
        if (n.computed) visit(n.key, scope, n);
        visit(n.value, scope, n); return;
      case "LabeledStatement": visit(n.body, scope, n); return;
      case "BreakStatement": case "ContinueStatement": return;
      case "UnaryExpression":
        if (n.operator === "typeof" && n.argument.type === "Identifier") return;   // safe on undeclared
        visit(n.argument, scope, n); return;
      case "MetaProperty": return;
      case "AssignmentExpression": visitPattern(n.left, scope, true); visit(n.right, scope, n); return;
      default: kids(n).forEach(([k, c]) => visit(c, scope, n, k));
    }
  }
  function visitMember(m, s) {
    if (m.computed) visit(m.key, s, m);
    if (m.type === "StaticBlock") { visit(m, s, m); return; }
    if (m.value) visit(m.value, s, m);
  }
  // Patterns: binding names are already declared; only default values / computed keys / member targets are references.
  function visitPattern(p, scope, isAssign) {
    if (!p) return;
    switch (p.type) {
      case "Identifier": if (isAssign) ref(p.name, p, scope); return;
      case "ObjectPattern": p.properties.forEach((x) => {
        if (x.type === "RestElement") return visitPattern(x.argument, scope, isAssign);
        if (x.computed) visit(x.key, scope, x);
        visitPattern(x.value, scope, isAssign);
      }); return;
      case "ArrayPattern": p.elements.forEach((x) => visitPattern(x, scope, isAssign)); return;
      case "RestElement": visitPattern(p.argument, scope, isAssign); return;
      case "AssignmentPattern": visitPattern(p.left, scope, isAssign); visit(p.right, scope, p); return;
      default: visit(p, scope, null);   // MemberExpression target
    }
  }
  visit(unit.ast, new Scope(null, true), null);
}

// Globals = everything declared at top level (any file), plus assignments to bare names.
const globalsSet = new Set();
for (const u of parsed) {
  const names = [];
  u.ast.body.forEach((s) => {
    collectVars(s, names);
    if (s.type === "VariableDeclaration") s.declarations.forEach((d) => patternNames(d.id, names));
    if (s.type === "ClassDeclaration" && s.id) names.push(s.id.name);
  });
  names.forEach((x) => globalsSet.add(x));
}

// window.X = ... / globalThis.X = ... / self.X = ... also creates a global.
(function collectWindowAssigns(n) {
  if (!n || typeof n.type !== "string") return;
  if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && !n.left.computed &&
      n.left.object.type === "Identifier" && /^(window|globalThis|self)$/.test(n.left.object.name) &&
      n.left.property.type === "Identifier") globalsSet.add(n.left.property.name);
  for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(collectWindowAssigns); else if (v && typeof v.type === "string") collectWindowAssigns(v); }
})({ type: "Root", body: parsed.map((u) => u.ast) });

const report = [];
for (const u of parsed) analyse(u, globalsSet, report);

const seen = new Set(); let count = 0;
report.sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line, undefined, { numeric: true }));
for (const r of report) {
  const k = `${r.file}:${r.line}:${r.name}`; if (seen.has(k)) continue; seen.add(k); count++;
  console.log(`UNDEFINED  ${r.file}:${r.line}  ${r.name}`);
}
console.log(`\n${units.length} scripts checked, ${count} undefined reference(s), ${parseErrors} parse error(s).`);
process.exit(count || parseErrors ? 1 : 0);
