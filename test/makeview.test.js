'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseMakeJust,
  buildMermaidDag,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildTargetCatalogMarkdown,
  buildTargetCatalogCsv,
} = require('../src/makeview');
const { MakeViewModel } = require('../src/view');
const { editorHtml, csp } = require('../src/html');

const mkPath = path.join(__dirname, '..', 'samples', 'Makefile');
const justPath = path.join(__dirname, '..', 'samples', 'justfile');
const mkText = fs.readFileSync(mkPath, 'utf8');
const justText = fs.readFileSync(justPath, 'utf8');

test('parseMakeJust parses Makefile targets, dependency edges, .PHONY and variables', () => {
  const p = parseMakeJust(mkText, 'Makefile');
  assert.equal(p.fileKind, 'Makefile');
  assert.equal(p.defaultTarget, 'all');
  assert.ok(p.targets.length >= 5);
  assert.ok(p.edges.length >= 4);
  assert.equal(p.variables.length, 3);
  assert.ok(p.phony.includes('build'));
});

test('static findings catch missing .PHONY, recursive shell var, curl|sh, dangerous rm -rf, duplicate target and undefined var', () => {
  const p = parseMakeJust(mkText, 'Makefile');
  const rules = new Set(p.findings.map((f) => f.rule));
  assert.ok(rules.has('missing-phony'));
  assert.ok(rules.has('recursive-var-shell'));
  assert.ok(rules.has('curl-pipe-shell'));
  assert.ok(rules.has('dangerous-rm-rf'));
  assert.ok(rules.has('duplicate-target'));
  assert.ok(rules.has('undefined-variable'));
});

test('clean justfile produces zero static findings and parses recipes, params and variables', () => {
  const p = parseMakeJust(justText, 'justfile');
  assert.equal(p.fileKind, 'Justfile');
  assert.equal(p.defaultTarget, 'default');
  assert.equal(p.targets.length, 5);
  assert.equal(p.variables.length, 2);
  assert.equal(p.findings.length, 0);
});

test('MakeViewModel filters by kind, findings and text', () => {
  const p = parseMakeJust(mkText, 'Makefile');
  const vm = new MakeViewModel(p, 'Makefile', mkText.length);
  assert.equal(vm.totalCount(), p.rows.length);
  assert.equal(vm.setFilter({ kind: 'variable' }), 3);
  assert.ok(vm.setFilter({ kind: 'target' }) >= 5);
  assert.ok(vm.setFilter({ kind: 'findings' }) >= 4);
  assert.ok(vm.setFilter({ text: 'deploy' }) >= 1);
  const d = vm.detail(1);
  assert.ok(d && d.name && Array.isArray(d.attrs));
});

test('buildMermaidDag, audit, diff and catalog exporters produce valid output', () => {
  const left = parseMakeJust(mkText, 'Makefile');
  const right = parseMakeJust(justText, 'justfile');

  const dag = buildMermaidDag(left);
  assert.ok(dag.includes('flowchart LR'));
  assert.ok(dag.includes('t_all --> t_build'));

  const audit = buildAuditMarkdown([{ fileName: 'Makefile', parsed: left }]);
  assert.ok(audit.includes('# Makefile & Justfile Safety and .PHONY Audit'));
  assert.ok(audit.includes('missing-phony'));

  const diff = buildDiffMarkdown('Makefile', left, 'justfile', right);
  assert.ok(diff.includes('Target Changes'));
  assert.ok(diff.includes('release'));

  const md = buildTargetCatalogMarkdown(left, 'Makefile');
  assert.ok(md.includes('```mermaid'));
  assert.ok(md.includes('## Variables'));

  const csv = buildTargetCatalogCsv(left);
  assert.ok(csv.startsWith('Category,Section,Name,Value,Status,Line\n'));
  assert.ok(csv.includes('GIT_SHA'));
});

test('editorHtml enforces strict CSP with nonce', () => {
  const c = csp('vscode-webview:', 'abc123');
  assert.ok(c.includes("default-src 'none'"));
  assert.ok(c.includes("script-src 'nonce-abc123'"));
  const html = editorHtml({ cspSource: 'vscode-webview:', script: 'v.js', styleUri: 'v.css', title: 'Makefile', nonce: 'abc123' });
  assert.ok(html.includes('nonce="abc123"'));
  assert.ok(html.includes('zovoMakeview.getPro'));
});
