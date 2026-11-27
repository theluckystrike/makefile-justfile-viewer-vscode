'use strict';
// Offline parser, target dependency DAG builder, static findings analyzer,
// audit/diff Markdown builders and Mermaid/CSV catalog exporter for
// Makefile, GNUmakefile, *.mk, justfile, Justfile and *.just.
// Zero make/just execution, zero network calls.

const COMMON_PHONY = new Set([
  'all', 'build', 'test', 'tests', 'clean', 'distclean', 'lint', 'fmt', 'format',
  'check', 'install', 'uninstall', 'deploy', 'dev', 'run', 'start', 'stop',
  'help', 'release', 'docker', 'ci', 'dist', 'docs', 'bench', 'benchmark', 'coverage',
]);

const BUILTIN_MAKE_VARS = new Set([
  'MAKE', 'MAKEFLAGS', 'MAKELEVEL', 'MAKEFILE_LIST', 'MAKECMDGOALS', 'CURDIR', 'SHELL',
  'CC', 'CXX', 'AR', 'AS', 'LD', 'RM', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'LDLIBS',
  'PATH', 'HOME', 'USER', 'PWD', 'TMPDIR', 'TERM', 'LANG', 'OS', 'PREFIX', 'DESTDIR',
  'VPATH', 'SUFFIXES', 'DEFAULT_GOAL', '.DEFAULT_GOAL', '.PHONY', '.SHELLFLAGS', '.RECIPEPREFIX',
  'CI', 'GITHUB_ACTIONS', 'GITHUB_SHA', 'GITHUB_REF', 'NODE_ENV', 'GOPATH', 'GOROOT', 'CARGO_HOME',
]);

const CURL_PIPE_SH_RE = /(?:curl|wget)\b[^|\n;]*\|\s*(?:sudo\s+)?(?:ba|da|z|a)?sh\b/i;
const RM_RF_UNQUOTED_RE = /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(?:\$[({][A-Za-z0-9_]+[})]|\/(?:\s|$)|\$[A-Za-z_][A-Za-z0-9_]*)|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+(?:\$[({][A-Za-z0-9_]+[})]|\/(?:\s|$)|\$[A-Za-z_][A-Za-z0-9_]*)/;

function detectFileKind(fileName) {
  const base = String(fileName || 'Makefile').split(/[\\/]/).pop() || 'Makefile';
  if (/justfile$/i.test(base) || /\.just$/i.test(base)) return 'Justfile';
  return 'Makefile';
}

function parseMakefile(lines) {
  const targets = [];
  const variables = [];
  const includes = [];
  const phonySet = new Set();
  let defaultGoal = '';
  let currentTarget = null;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Recipe line (starts with tab)
    if (rawLine.startsWith('\t') && currentTarget) {
      currentTarget.commands.push({ line: lineNo, text: trimmed });
      continue;
    }

    currentTarget = null;

    // Include directive
    const incM = trimmed.match(/^(-?s?include)\s+(.+)$/);
    if (incM) {
      for (const p of incM[2].trim().split(/\s+/)) {
        if (p) includes.push({ directive: incM[1], path: p, line: lineNo, raw: trimmed });
      }
      continue;
    }

    // .PHONY declaration
    const phonyM = trimmed.match(/^\.PHONY\s*:\s*(.*)$/);
    if (phonyM) {
      for (const tok of phonyM[1].trim().split(/\s+/)) {
        if (tok && !tok.startsWith('#')) phonySet.add(tok);
      }
      continue;
    }

    // Variable assignment: [export] NAME [:=|?=|+=|!=|=] VALUE
    const varM = trimmed.match(/^(export\s+)?([A-Za-z_.][A-Za-z0-9_.-]*)\s*(:=|\?=|\+=|!=|=)\s*(.*)$/);
    if (varM && !trimmed.match(/^[A-Za-z0-9_./%-]+\s*:\s*(?!=)/)) {
      const name = varM[2];
      const op = varM[3];
      const value = varM[4].replace(/\s+#.*$/, '').trim();
      if (name === '.DEFAULT_GOAL' && value) defaultGoal = value;
      variables.push({
        name,
        op,
        value,
        exported: !!varM[1],
        line: lineNo,
        raw: trimmed,
      });
      continue;
    }

    // Target rule: target1 target2 : prereq1 prereq2
    const tgtM = trimmed.match(/^([A-Za-z0-9_./%$\-+@ -]+?)\s*:{1,2}\s*([^=;]*?)(?:\s*#.*)?$/);
    if (tgtM) {
      const lhs = tgtM[1].trim();
      if (lhs.startsWith('.') && lhs !== '.DEFAULT') continue;
      if (/^(if|ifeq|ifneq|ifdef|ifndef|else|endif|define|endef)\b/.test(lhs)) continue;
      const rhs = (tgtM[2] || '').replace(/\|.*$/, '').trim();
      const prereqs = rhs ? rhs.split(/\s+/).filter((x) => x && !x.startsWith('#')) : [];
      const names = lhs.split(/\s+/).filter(Boolean);
      for (const name of names) {
        const entry = {
          name,
          prereqs,
          params: [],
          attrs: [],
          phony: phonySet.has(name),
          commands: [],
          line: lineNo,
          raw: trimmed,
        };
        targets.push(entry);
        currentTarget = entry;
      }
    }
  }

  for (const t of targets) {
    if (phonySet.has(t.name)) t.phony = true;
  }
  if (!defaultGoal && targets.length) defaultGoal = targets[0].name;

  return { targets, variables, includes, phony: [...phonySet], defaultTarget: defaultGoal || '(none)' };
}

function parseJustfile(lines) {
  const targets = [];
  const variables = [];
  const includes = [];
  const pendingAttrs = [];
  let currentTarget = null;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Indented recipe line
    if (/^(\t|  +)/.test(rawLine) && currentTarget) {
      currentTarget.commands.push({ line: lineNo, text: trimmed });
      continue;
    }

    currentTarget = null;

    // Attribute like [private] or [confirm("...")]
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      pendingAttrs.push(trimmed.slice(1, -1));
      continue;
    }

    // import / mod / set
    const impM = trimmed.match(/^(import\??|mod\??)\s+['"]?([^'"]+)['"]?/);
    if (impM) {
      includes.push({ directive: impM[1], path: impM[2].trim(), line: lineNo, raw: trimmed });
      pendingAttrs.length = 0;
      continue;
    }
    if (/^set\s+/.test(trimmed) || /^alias\s+/.test(trimmed)) {
      pendingAttrs.length = 0;
      continue;
    }

    // Variable: [export] name := value
    const varM = trimmed.match(/^(export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*:=\s*(.+)$/);
    if (varM) {
      variables.push({
        name: varM[2],
        op: ':=',
        value: varM[3].trim(),
        exported: !!varM[1],
        line: lineNo,
        raw: trimmed,
      });
      pendingAttrs.length = 0;
      continue;
    }

    // Recipe: [@]name [param1 param2='default']: [dep1 dep2]
    const recM = trimmed.match(/^(@?)([A-Za-z_][A-Za-z0-9_-]*)(?:\s+([^:]+))?\s*:\s*(.*)$/);
    if (recM) {
      const name = recM[2];
      const paramStr = (recM[3] || '').trim();
      const params = paramStr ? paramStr.split(/\s+/).map((p) => p.replace(/^[*+]/, '').split('=')[0]) : [];
      const depStr = (recM[4] || '').replace(/\s*#.*$/, '').trim();
      const prereqs = depStr
        ? depStr.split(/\s+/).map((d) => d.replace(/^\(/, '').replace(/\)$/, '')).filter((d) => d && !d.startsWith('&&'))
        : [];
      const entry = {
        name,
        prereqs,
        params,
        attrs: pendingAttrs.slice(),
        phony: true, // Justfile recipes are always phony by design
        commands: [],
        line: lineNo,
        raw: trimmed,
      };
      pendingAttrs.length = 0;
      targets.push(entry);
      currentTarget = entry;
    }
  }

  return {
    targets,
    variables,
    includes,
    phony: targets.map((t) => t.name),
    defaultTarget: targets.length ? targets[0].name : '(none)',
  };
}

function parseMakeJust(input, fileName = 'Makefile') {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  const lines = text ? text.split(/\r?\n/) : [];
  const fileKind = detectFileKind(fileName);
  const parsed = fileKind === 'Justfile' ? parseJustfile(lines) : parseMakefile(lines);
  const { targets, variables, includes, phony, defaultTarget } = parsed;

  const edges = [];
  for (const t of targets) {
    for (const dep of t.prereqs) {
      edges.push({ from: t.name, to: dep, line: t.line });
    }
  }

  // Static findings
  const findings = [];
  const addFinding = (severity, category, rule, line, target, message) => {
    findings.push({ severity, category, rule, line, target, message });
  };

  // 1. Duplicate targets
  const seenTargets = new Map();
  for (const t of targets) {
    if (seenTargets.has(t.name)) {
      addFinding('warning', 'structure', 'duplicate-target', t.line, t.name, `Target "${t.name}" is already defined on line ${seenTargets.get(t.name)}.`);
    } else {
      seenTargets.set(t.name, t.line);
    }
  }

  // 2. Missing .PHONY (Makefile only)
  if (fileKind === 'Makefile') {
    for (const t of targets) {
      if (!t.phony && COMMON_PHONY.has(t.name.toLowerCase())) {
        addFinding('warning', 'phony', 'missing-phony', t.line, t.name, `Target "${t.name}" is not listed in .PHONY and will be skipped if a file named "${t.name}" exists.`);
      }
    }
  }

  // 3. Recursive '=' with $(shell ...) or backticks (Makefile only)
  if (fileKind === 'Makefile') {
    for (const v of variables) {
      if (v.op === '=' && (/\$\(shell\b/.test(v.value) || /`[^`]+`/.test(v.value))) {
        addFinding('warning', 'performance', 'recursive-var-shell', v.line, v.name, `Variable "${v.name}" uses recursive "=" with a shell command; use ":=" so it evaluates once.`);
      }
    }
  }

  // 4. Recipe command checks: curl|sh, unquoted rm -rf, undefined variable references
  const definedVars = new Set(variables.map((v) => v.name));
  const reportedUndef = new Set();

  for (const t of targets) {
    const localParams = new Set(t.params || []);
    for (const cmd of t.commands) {
      if (CURL_PIPE_SH_RE.test(cmd.text)) {
        addFinding('error', 'security', 'curl-pipe-shell', cmd.line, t.name, `Recipe "${t.name}" pipes a remote script directly into a shell (curl/wget | sh).`);
      }
      if (RM_RF_UNQUOTED_RE.test(cmd.text)) {
        addFinding('error', 'safety', 'dangerous-rm-rf', cmd.line, t.name, `Recipe "${t.name}" runs rm -rf with an unquoted variable or root path; quote and guard variables before deletion.`);
      }

      if (fileKind === 'Makefile') {
        const refRe = /\$(?:\(([A-Za-z_][A-Za-z0-9_]*)\)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g;
        let rm;
        while ((rm = refRe.exec(cmd.text)) !== null) {
          const vName = rm[1] || rm[2];
          if (!vName || definedVars.has(vName) || BUILTIN_MAKE_VARS.has(vName)) continue;
          const key = `${t.name}:${vName}`;
          if (!reportedUndef.has(key)) {
            reportedUndef.add(key);
            addFinding('warning', 'variable', 'undefined-variable', cmd.line, t.name, `Variable "$(${vName})" referenced in "${t.name}" is not defined in this file.`);
          }
        }
      } else {
        const jRefRe = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;
        let jm;
        while ((jm = jRefRe.exec(cmd.text)) !== null) {
          const vName = jm[1];
          if (!vName || definedVars.has(vName) || localParams.has(vName)) continue;
          const key = `${t.name}:${vName}`;
          if (!reportedUndef.has(key)) {
            reportedUndef.add(key);
            addFinding('warning', 'variable', 'undefined-variable', cmd.line, t.name, `Variable "{{${vName}}}" referenced in "${t.name}" is not defined as a variable or recipe parameter.`);
          }
        }
      }
    }
  }

  // Build unified rows for the viewer table
  const rows = [];
  const pushRow = (kind, section, name, signature, badge, line, raw, attrs, matchedFindings) => {
    const flist = matchedFindings || [];
    const errorCount = flist.filter((f) => f.severity === 'error').length;
    const warningCount = flist.filter((f) => f.severity === 'warning').length;
    const risk = errorCount ? `${errorCount} error${errorCount > 1 ? 's' : ''}` : (warningCount ? `${warningCount} warning${warningCount > 1 ? 's' : ''}` : 'ok');
    rows.push({
      index: rows.length + 1,
      line,
      kind,
      section,
      name,
      signature,
      badge,
      risk,
      errorCount,
      warningCount,
      raw,
      attrs,
      findings: flist,
    });
  };

  for (const t of targets) {
    const depText = t.prereqs.length ? `deps: ${t.prereqs.join(', ')}` : '(no dependencies)';
    const cmdPreview = t.commands.map((c) => `  ${c.text}`).join('\n');
    const flist = findings.filter((f) => f.target === t.name);
    pushRow(
      'target',
      fileKind === 'Justfile' ? 'Recipes' : 'Targets',
      t.name,
      depText,
      t.phony ? '.PHONY' : 'file',
      t.line,
      cmdPreview ? `${t.raw}\n${cmdPreview}` : t.raw,
      [
        { key: 'Name', value: t.name },
        { key: 'Phony', value: t.phony ? 'yes' : 'no' },
        { key: 'Prerequisites', value: t.prereqs.length ? t.prereqs.join(', ') : '(none)' },
        { key: 'Parameters', value: t.params.length ? t.params.join(', ') : '(none)' },
        { key: 'Recipe Lines', value: String(t.commands.length) },
      ],
      flist,
    );
  }

  for (const v of variables) {
    const flist = findings.filter((f) => f.target === v.name);
    pushRow(
      'variable',
      'Variables',
      v.name,
      `${v.op} ${v.value}`,
      v.exported ? `export ${v.op}` : v.op,
      v.line,
      v.raw,
      [
        { key: 'Variable', value: v.name },
        { key: 'Operator', value: v.op },
        { key: 'Value', value: v.value || '(empty)' },
        { key: 'Exported', value: v.exported ? 'yes' : 'no' },
      ],
      flist,
    );
  }

  for (const inc of includes) {
    pushRow(
      'include',
      'Includes',
      inc.path,
      inc.directive,
      inc.directive,
      inc.line,
      inc.raw,
      [
        { key: 'Directive', value: inc.directive },
        { key: 'Path', value: inc.path },
      ],
      [],
    );
  }

  const findingErrors = findings.filter((f) => f.severity === 'error').length;
  const findingWarnings = findings.filter((f) => f.severity === 'warning').length;

  return {
    fileName,
    fileKind,
    defaultTarget,
    totalLines: lines.length,
    targets,
    edges,
    phony,
    variables,
    includes,
    findings,
    rows,
    stats: {
      rowCount: rows.length,
      targetCount: targets.length,
      edgeCount: edges.length,
      phonyCount: phony.length,
      variableCount: variables.length,
      includeCount: includes.length,
      findingErrors,
      findingWarnings,
    },
  };
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function mermaidId(name) {
  return `t_${String(name).replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function buildMermaidDag(parsed) {
  const lines = ['flowchart LR'];
  for (const t of parsed.targets) {
    lines.push(`  ${mermaidId(t.name)}["${t.name.replace(/"/g, "'")}"]`);
  }
  for (const e of parsed.edges) {
    lines.push(`  ${mermaidId(e.from)} --> ${mermaidId(e.to)}`);
  }
  return lines.join('\n');
}

function buildAuditMarkdown(entries) {
  const lines = ['# Makefile & Justfile Safety and .PHONY Audit', ''];
  let totalErrors = 0;
  let totalWarnings = 0;
  for (const e of entries) {
    totalErrors += e.parsed.stats.findingErrors;
    totalWarnings += e.parsed.stats.findingWarnings;
  }
  lines.push(`- Files audited: ${entries.length}`);
  lines.push(`- Total errors: ${totalErrors}`);
  lines.push(`- Total warnings: ${totalWarnings}`);
  lines.push('');

  for (const { fileName, parsed } of entries) {
    lines.push(`## ${fileName} (${parsed.fileKind})`);
    lines.push('');
    lines.push(`- Default target: \`${parsed.defaultTarget}\``);
    lines.push(`- Counts: ${parsed.stats.targetCount} targets, ${parsed.stats.edgeCount} dependency edges, ${parsed.stats.phonyCount} .PHONY, ${parsed.stats.variableCount} variables`);
    lines.push('');
    if (!parsed.findings.length) {
      lines.push('No static safety or .PHONY findings.');
      lines.push('');
    } else {
      lines.push('| Severity | Rule | Line | Target | Finding |');
      lines.push('| --- | --- | ---: | --- | --- |');
      for (const f of parsed.findings) {
        lines.push(`| ${f.severity.toUpperCase()} | \`${f.rule}\` | ${f.line} | \`${f.target}\` | ${f.message} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function buildDiffMarkdown(leftName, left, rightName, right) {
  const lines = [
    '# Makefile / Justfile Comparison',
    '',
    `- Baseline: \`${leftName}\` (${left.fileKind}, ${left.stats.targetCount} targets, ${left.stats.variableCount} vars)`,
    `- Target: \`${rightName}\` (${right.fileKind}, ${right.stats.targetCount} targets, ${right.stats.variableCount} vars)`,
    '',
  ];

  const diffSet = (title, lArr, rArr) => {
    const ls = new Set(lArr);
    const rs = new Set(rArr);
    const added = [...rs].filter((x) => !ls.has(x));
    const removed = [...ls].filter((x) => !rs.has(x));
    lines.push(`## ${title}`);
    lines.push('');
    if (!added.length && !removed.length) {
      lines.push('No changes.');
    } else {
      for (const a of added) lines.push(`- Added: \`${a}\``);
      for (const r of removed) lines.push(`- Removed: \`${r}\``);
    }
    lines.push('');
  };

  diffSet('Target Changes', left.targets.map((t) => t.name), right.targets.map((t) => t.name));
  diffSet('Dependency Edge Changes', left.edges.map((e) => `${e.from} -> ${e.to}`), right.edges.map((e) => `${e.from} -> ${e.to}`));
  diffSet('Variable Changes', left.variables.map((v) => `${v.name} ${v.op} ${v.value}`), right.variables.map((v) => `${v.name} ${v.op} ${v.value}`));

  return `${lines.join('\n')}\n`;
}

function buildTargetCatalogMarkdown(parsed, fileName) {
  const lines = [
    `# Target DAG & Variable Catalog: ${fileName}`,
    '',
    `- Format: ${parsed.fileKind}`,
    `- Default target: \`${parsed.defaultTarget}\``,
    '',
    '## Target Dependency DAG (Mermaid)',
    '',
    '```mermaid',
    buildMermaidDag(parsed),
    '```',
    '',
    '## Targets & Recipes',
    '',
  ];
  if (parsed.targets.length) {
    lines.push('| Target | Phony | Prerequisites | Commands | Line |');
    lines.push('| --- | --- | --- | ---: | ---: |');
    for (const t of parsed.targets) {
      lines.push(`| \`${t.name}\` | ${t.phony ? 'yes' : 'no'} | ${t.prereqs.join(', ') || '-'} | ${t.commands.length} | ${t.line} |`);
    }
  } else {
    lines.push('None.');
  }
  lines.push('', '## Variables', '');
  if (parsed.variables.length) {
    lines.push('| Name | Operator | Value | Line |');
    lines.push('| --- | --- | --- | ---: |');
    for (const v of parsed.variables) {
      lines.push(`| \`${v.name}\` | \`${v.op}\` | \`${v.value}\` | ${v.line} |`);
    }
  } else {
    lines.push('None.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildTargetCatalogCsv(parsed) {
  const out = ['Category,Section,Name,Value,Status,Line'];
  for (const r of parsed.rows) {
    out.push([r.kind, r.section, r.name, r.signature, r.risk, r.line].map(csvCell).join(','));
  }
  return `${out.join('\n')}\n`;
}

module.exports = {
  parseMakeJust,
  buildMermaidDag,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildTargetCatalogMarkdown,
  buildTargetCatalogCsv,
};
