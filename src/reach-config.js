'use strict';
module.exports = {
  prefix: 'zovoMakeview',
  triesKey: 'zovoMakeview.proTrial',
  slot: '#protools',
  tools: [
    { id: 'auditBuildFile', title: 'Audit Makefile or Justfile safety', command: 'zovoMakeview.auditBuildFile' },
    { id: 'diffBuildFiles', title: 'Compare two build files', command: 'zovoMakeview.diffBuildFiles' },
    { id: 'exportTargetGraph', title: 'Export target DAG and catalog', command: 'zovoMakeview.exportTargetGraph' },
  ],
};
