'use strict';
// Pro tools for Makefile & Justfile Graph View:
//   1. auditBuildFile: Offline Markdown Makefile/Justfile safety and .PHONY audit.
//   2. diffBuildFiles: Compare two Makefiles or Justfiles in Markdown.
//   3. exportTargetGraph: Non-destructive Mermaid target DAG + Markdown and CSV catalog export.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  parseMakeJust,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildTargetCatalogMarkdown,
  buildTargetCatalogCsv,
} = require('./makeview');

const MATCH_RE = /^(Makefile|GNUmakefile|.*\.mk|justfile|Justfile|.*\.just)$/i;

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 1; i < 10000; i += 1) {
    const cand = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function resolveTargetUri(uri, provider, openLabel = 'Select Makefile or Justfile') {
  if (uri && uri.scheme) return uri;
  if (provider && provider.active && provider.active.uri) return provider.active.uri;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document && MATCH_RE.test(path.basename(ed.document.uri.fsPath || ed.document.uri.path))) {
    return ed.document.uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Makefiles & Justfiles': ['mk', 'just', '*'] },
    openLabel,
  });
  return picked && picked[0] ? picked[0] : null;
}

function listBuildFilesInDir(dirPath, maxDepth = 4) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && MATCH_RE.test(e.name)) out.push(full);
      else if (e.isDirectory() && depth < maxDepth) walk(full, depth + 1);
    }
  }
  walk(dirPath, 0);
  return out.sort();
}

function createTools({ provider, pro, reach }) {
  async function auditBuildFile(uri, opts = {}) {
    if (!(await pro.allowed('auditBuildFile', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const isDir = target.scheme === 'file' && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    const files = isDir ? listBuildFilesInDir(targetPath) : [targetPath];
    if (!files.length) {
      vscode.window.showInformationMessage('No Makefile or Justfile files were found in this folder.');
      return undefined;
    }

    const entries = [];
    for (const f of files) {
      const buf = f === targetPath && target.scheme !== 'file'
        ? Buffer.from(await vscode.workspace.fs.readFile(target))
        : fs.readFileSync(f);
      const label = isDir ? path.relative(targetPath, f) : path.basename(f);
      entries.push({ fileName: label, parsed: parseMakeJust(buf, label) });
    }
    const md = buildAuditMarkdown(entries);
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('auditBuildFile');
    if (reach) reach.refresh();
    return { files: files.length, markdown: md };
  }

  async function diffBuildFiles(uri, opts = {}) {
    if (!(await pro.allowed('diffBuildFiles', opts))) return undefined;
    const left = await resolveTargetUri(uri, provider, 'Select baseline Makefile or Justfile');
    if (!left) return undefined;

    let right = opts.compareUri || null;
    if (!right) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Makefiles & Justfiles': ['mk', 'just', '*'] },
        openLabel: 'Select second Makefile or Justfile to compare',
      });
      right = picked && picked[0] ? picked[0] : null;
    }
    if (!right) return undefined;

    const leftBuf = Buffer.from(await vscode.workspace.fs.readFile(left));
    const rightBuf = Buffer.from(await vscode.workspace.fs.readFile(right));
    const leftName = path.basename(left.fsPath || left.path);
    const rightName = path.basename(right.fsPath || right.path);
    const md = buildDiffMarkdown(
      leftName,
      parseMakeJust(leftBuf, leftName),
      rightName,
      parseMakeJust(rightBuf, rightName),
    );
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('diffBuildFiles');
    if (reach) reach.refresh();
    return { markdown: md };
  }

  async function exportTargetGraph(uri, opts = {}) {
    if (!(await pro.allowed('exportTargetGraph', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const bytes = await vscode.workspace.fs.readFile(target);
    const baseName = path.basename(targetPath);
    const parsed = parseMakeJust(Buffer.from(bytes), baseName);
    const stemRaw = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'Makefile';
    const defaultOut = uniquePath(path.join(path.dirname(targetPath), `${stemRaw}.targets.csv`));
    const saveUri = opts.outPath
      ? vscode.Uri.file(uniquePath(opts.outPath))
      : await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultOut),
        filters: { 'CSV Target Catalog': ['csv'] },
        saveLabel: 'Save Mermaid target DAG, Markdown and CSV catalog',
      });
    if (!saveUri) return undefined;

    const csvPath = uniquePath(saveUri.fsPath);
    const dir = path.dirname(csvPath);
    const stem = path.basename(csvPath, '.csv').replace(/\.targets$/i, '');
    const mdPath = uniquePath(path.join(dir, `${stem}.targets.md`));

    fs.writeFileSync(csvPath, buildTargetCatalogCsv(parsed), 'utf8');
    fs.writeFileSync(mdPath, buildTargetCatalogMarkdown(parsed, baseName), 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('exportTargetGraph');
    if (reach) reach.refresh();
    return { files: [csvPath, mdPath], entries: parsed.stats.rowCount };
  }

  return { auditBuildFile, diffBuildFiles, exportTargetGraph };
}

module.exports = { createTools, uniquePath, listBuildFilesInDir };
