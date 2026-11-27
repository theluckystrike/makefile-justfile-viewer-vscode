'use strict';
// View model for Makefile & Justfile Graph View: pagination and filtering by kind, findings and text.

class MakeViewModel {
  constructor(parsed, name, fileSize) {
    this.parsed = parsed;
    this.name = name;
    this.fileSize = fileSize;
    this.filter = { text: '', kind: '' };
    this.filtered = parsed.rows.slice();
  }

  summary() {
    const p = this.parsed;
    const s = p.stats;
    return {
      name: this.name,
      fileSize: this.fileSize,
      fileKind: p.fileKind,
      defaultTarget: p.defaultTarget,
      totalLines: p.totalLines,
      rowCount: s.rowCount,
      targetCount: s.targetCount,
      edgeCount: s.edgeCount,
      phonyCount: s.phonyCount,
      variableCount: s.variableCount,
      includeCount: s.includeCount,
      findingErrors: s.findingErrors,
      findingWarnings: s.findingWarnings,
      targets: p.targets,
      edges: p.edges,
      phony: p.phony,
      variables: p.variables,
      includes: p.includes,
      findings: p.findings,
    };
  }

  totalCount() {
    return this.parsed.rows.length;
  }

  count() {
    return this.filtered.length;
  }

  setFilter(f) {
    const text = f && typeof f.text === 'string' ? f.text.trim().toLowerCase() : '';
    const kind = f && typeof f.kind === 'string' ? f.kind.trim() : '';
    this.filter = { text, kind };
    this.filtered = this.parsed.rows.filter((r) => {
      if (kind && kind !== 'findings' && r.kind !== kind) return false;
      if (kind === 'findings' && !r.errorCount && !r.warningCount) return false;
      if (text) {
        const hay = `${r.name} ${r.kind} ${r.section} ${r.signature} ${r.badge} ${r.raw}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
    return this.filtered.length;
  }

  rows(from, limit) {
    const start = Math.max(0, Number(from) || 0);
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.filtered.slice(start, start + n).map((r) => ({
      index: r.index,
      line: r.line,
      name: r.name,
      kind: r.kind,
      section: r.section,
      signature: r.signature,
      badge: r.badge,
      risk: r.risk,
      errorCount: r.errorCount,
      warningCount: r.warningCount,
    }));
  }

  detail(index) {
    const r = this.parsed.rows.find((x) => x.index === index) || this.parsed.rows[0] || null;
    if (!r) return null;
    return {
      index: r.index,
      line: r.line,
      name: r.name,
      kind: r.kind,
      section: r.section,
      badge: r.badge,
      risk: r.risk,
      raw: r.raw,
      findings: r.findings,
      attrs: r.attrs,
    };
  }
}

module.exports = { MakeViewModel };
