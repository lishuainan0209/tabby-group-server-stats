const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '..');
const ts = require(path.join(repo, 'node_modules/typescript'));
const source = fs.readFileSync(path.join(repo, 'src/components/settings.component.ts'), 'utf8');
let componentMetadata;
const noopDecorator = () => () => {};
const exportsObject = {};
const sourceModules = new Map();
function loadPureSource(relative) {
  const absolute = path.resolve(repo, relative);
  if (sourceModules.has(absolute)) return sourceModules.get(absolute);
  const exports = {};
  sourceModules.set(absolute, exports);
  const javascript = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  vm.runInNewContext(javascript, { exports, console, require: name => {
    if (!name.startsWith('.')) throw Error('Unexpected pure module ' + name);
    const target = path.resolve(path.dirname(absolute), name);
    return target.endsWith('.json') ? JSON.parse(fs.readFileSync(target, 'utf8')) : loadPureSource(target + '.ts');
  } });
  return exports;
}
const mocks = {
  '@angular/core': {
    Component: metadata => { componentMetadata = metadata; return klass => klass; },
    Injectable: noopDecorator, HostListener: noopDecorator, ViewChild: noopDecorator,
  },
  '@angular/platform-browser': {},
  'tabby-core': {},
  'tabby-settings': { SettingsTabProvider: class {} },
  '../config': { POPULAR_ICON_PRESETS: [] },
  '../builtin-metrics': loadPureSource('src/builtin-metrics.ts'),
  '../preset-library': loadPureSource('src/preset-library.ts'),
  '../preset-github': loadPureSource('src/preset-github.ts'),
  '../metric-colors': loadPureSource('src/metric-colors.ts'),
  '../disk-io': loadPureSource('src/disk-io.ts'),
  '../translations': loadPureSource('src/translations.ts'),
  '../display-scope': loadPureSource('src/display-scope.ts'),
  '../tutorial': { openTutorialPdf: async () => {} },
};
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  experimentalDecorators: true,
}}).outputText;
let confirmationHandler = () => true;
vm.runInNewContext(compiled, {
  require: name => { if (!(name in mocks)) throw Error('Unexpected module ' + name); return mocks[name]; },
  exports: exportsObject, console, confirm: message => confirmationHandler(message), setTimeout, __dirname: '/plugin/dist',
});
function withConfirmation(answer, run) {
  const messages = [];
  const previous = confirmationHandler;
  confirmationHandler = message => { messages.push(message); return answer; };
  try { run(messages); } finally { confirmationHandler = previous; }
}
let saves = 0;
const oldMetric = {
  id: 'old', label: 'Old', command: 'printf 17', type: 'text', suffix: 'G',
  colorRules: [{ operator: '>', value: '10', color: '#ff0000' }],
};
const config = { store: { plugin: { serverStats: { customMetrics: [oldMetric], metricGroups: [] } } }, save: () => saves++ };
const s = new exportsObject.ServerStatsSettingsComponent({}, config, {});
// Existing configuration remains compatible and does not get changed by opening/cancelling an editor.
s.editMetric(0);
assert.equal(s.currentMetric.id, 'old');
assert.equal(s.currentMetric.showWhenUnavailable, true);
s.currentMetric.label = 'Changed draft';
assert.equal(oldMetric.label, 'Old');
s.cancelEdit();
assert.equal(oldMetric.label, 'Old');

// Group changes stay local until saved; every child defaults to visible on validation failure.
s.newGroup();
assert.equal(config.store.plugin.serverStats.metricGroups.length, 0);
assert.equal(s.isGroupValid(), false);
Object.assign(s.currentMetric, { label: 'Summary', command: 'printf 20', type: 'text' });
const mainId = s.currentMetric.id;
s.currentGroup.label = 'Disks';
s.currentGroup.mode = 'carousel';
s.addChild();
assert.equal(s.currentMetric.showWhenUnavailable, true);
Object.assign(s.currentMetric, { label: 'Data1', command: 'printf 30', checkCommand: 'exit 0', detailCommand: 'printf detail', type: 'text' });
const child1Id = s.currentMetric.id;
s.addChild();
Object.assign(s.currentMetric, { label: 'Data2', command: 'printf 40', showWhenUnavailable: false, type: 'text' });
const child2Id = s.currentMetric.id;
assert.notEqual(child1Id, child2Id);
s.moveChild(1, -1);
assert.equal(s.currentMetric.id, child2Id);
assert.equal(s.editingChildIndex, 0);
s.selectGroupMetric(-1);
assert.equal(s.currentMetric.id, mainId);
assert.equal(s.currentMetric.command, 'printf 20');
assert.equal(s.isGroupValid(), true);
s.saveGroup(true);
assert.equal(config.store.plugin.serverStats.metricGroups.length, 1);
const stored = config.store.plugin.serverStats.metricGroups[0];
assert.equal(stored.main.id, mainId);
assert.equal(stored.children[0].id, child2Id);
assert.equal(stored.children[0].showWhenUnavailable, false);
assert.equal(stored.children[1].id, child1Id);
assert.equal(stored.children[1].showWhenUnavailable, true);
assert.equal(s.currentGroup, null);

// Cancellation never changes live configuration. Editing and saving retain all metric IDs and flags.
s.editGroup(0);
s.currentGroup.label = 'Cancelled';
s.selectGroupMetric(0);
s.currentMetric.showWhenUnavailable = true;
s.cancelEdit();
assert.equal(stored.label, 'Disks');
assert.equal(stored.children[0].showWhenUnavailable, false);
s.editGroup(0);
s.selectGroupMetric(1);
s.removeChild(0);
assert.equal(s.currentMetric.id, child1Id);
assert.equal(s.editingChildIndex, 0);
s.saveMetric(true);
assert.equal(config.store.plugin.serverStats.metricGroups[0].children[0].id, child1Id);

// Reordering singles while editing never updates the wrong metric.
config.store.plugin.serverStats.customMetrics.push({ id: 'other', label: 'Other', command: 'printf other', type: 'text' });
s.editMetric(0);
s.currentMetric.label = 'Updated old';
s.onDragStart(0);
s.onDrop(1);
s.saveMetric(true);
assert.equal(config.store.plugin.serverStats.customMetrics[1].id, 'old');
assert.equal(config.store.plugin.serverStats.customMetrics[1].label, 'Updated old');
assert.equal(config.store.plugin.serverStats.customMetrics[0].label, 'Other');
assert.equal(config.store.plugin.serverStats.customMetrics[1].suffix, 'G');
assert.equal(config.store.plugin.serverStats.customMetrics[1].colorRules.length, 1);

// Invalid numeric settings cannot persist; stdout checks intentionally permit an empty expected output.
const valid = { label: 'Test', command: 'printf 1', type: 'text', checkCommand: 'exit 0', checkMode: 'exitCode', checkExpected: '0' };
assert.equal(s.isMetricValid(valid), true);
for (const checkExpected of ['-1', '256', '1.5', 'abc']) assert.equal(s.isMetricValid({ ...valid, checkExpected }), false);
for (const interval of [-1, 0, Infinity, NaN]) assert.equal(s.isMetricValid({ ...valid, interval }), false);
assert.equal(s.isMetricValid({ ...valid, checkMode: 'output', checkExpected: '' }), true);
assert.ok(saves >= 3);

function scopeFixture() {
  const config = { store: {
    profiles: [
      { id: 'ssh:p1', name: 'P1', type: 'ssh', get options() { throw Error('Scope UI must not read connection secrets/options'); } },
      { id: 'ssh:p2', name: 'P2', type: 'ssh' },
      { id: 'layout:mixed', name: 'P1 / P2 / P1', type: 'split-layout' },
    ],
    plugin: { serverStats: { customMetrics: [{ id: 'legacy', label: 'Legacy', command: 'printf 1', type: 'text' }], metricGroups: [] } },
  }, save() {} };
  return { config, editor: new exportsObject.ServerStatsSettingsComponent({}, config, {}) };
}

const { HostConfigProxy } = loadPureSource('tests/helpers/host-config.ts');
function hostDefaults() {
  const exports = {};
  const javascript = ts.transpileModule(fs.readFileSync(path.join(repo, 'src/config.ts'), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true,
  } }).outputText;
  vm.runInNewContext(javascript, { exports, require: name => {
    if (name === '@angular/core') return { Injectable: noopDecorator };
    if (name === 'tabby-core') return { ConfigProvider: class {} };
    if (name === './metric-model') return loadPureSource('src/metric-model.ts');
    if (name === './metric-colors') return loadPureSource('src/metric-colors.ts');
    if (name === './icons/presets') return {};
    throw Error('Unexpected config dependency ' + name);
  } });
  return { profiles: [], language: 'en', ...new exports.ServerStatsConfigProvider().defaults };
}

function hostSettingsFixture(raw = {}) {
  const defaults = hostDefaults();
  let savedRaw;
  let saveCount = 0;
  const config = { store: new HostConfigProxy(raw, defaults), save() {
    saveCount++;
    savedRaw = JSON.parse(JSON.stringify(raw));
  } };
  const editor = new exportsObject.ServerStatsSettingsComponent({}, config, {});
  return { editor, config, raw, get saves() { return saveCount; }, get snapshot() { return savedRaw; } };
}

test('host config fixture enforces structural getters, mutable maps and raw-backed persistence', () => {
  const raw = {};
  const proxy = new HostConfigProxy(raw, { flags: { enabled: true }, empty: {}, mutable: { __nonStructural: true }, list: [] });
  assert.throws(() => { 'use strict'; proxy.flags = { enabled: false }; }, TypeError);
  proxy.flags.enabled = false;
  assert.equal(raw.flags.enabled, false);
  assert(Object.keys(proxy.flags).includes('__getValue'), 'Real host helper functions are enumerable');
  proxy.empty = proxy.empty || {};
  proxy.empty.lost = true;
  assert.equal(proxy.empty.lost, undefined, 'Empty leaf defaults are detached clones');
  assert.equal(raw.empty, undefined);
  proxy.mutable.retained = true;
  proxy.list.push('retained');
  assert.equal(raw.mutable.retained, true);
  assert.equal(raw.mutable.__nonStructural, undefined);
  assert.equal(raw.list[0], 'retained');
  proxy.undeclared = ['not persisted'];
  assert.equal(raw.undeclared, undefined);
});

test('settings constructor migrates a fresh host ConfigProxy without assigning structural objects', () => {
  const fixture = hostSettingsFixture();
  const conf = fixture.config.store.plugin.serverStats;
  assert.equal(conf.builtinDefaultsVersion, 1);
  assert.equal(fixture.raw.plugin.serverStats.builtinDefaultsVersion, 1);
  assert.equal(fixture.editor.builtinKeys.join(','), 'ram,net,load');
  assert.equal(conf.defaultMetrics.ram, true);
  assert.equal(conf.defaultMetrics.net, true);
  assert.equal(conf.defaultMetrics.load, true);
  assert.equal(conf.defaultMetrics.cpu, false);
  assert.equal(conf.defaultMetrics.disk, false);
  assert.equal(conf.customMetrics.length, 0);
  assert.equal(fixture.saves, 1);
  assert(!Object.keys(fixture.raw.plugin.serverStats.defaultMetrics).some(key => key.startsWith('__')));
});

test('the first memory override survives a host save/reload and can be restored then edited again', () => {
  const fixture = hostSettingsFixture();
  fixture.editor.editBuiltin('ram');
  fixture.editor.currentMetric.command = 'printf 43';
  fixture.editor.currentMetric.detailCommand = 'printf available';
  fixture.editor.saveMetric(true);
  assert.equal(fixture.raw.plugin.serverStats.defaultMetricOverrides.ram.command, 'printf 43');
  const restored = hostSettingsFixture(fixture.snapshot);
  assert.equal(restored.saves, 0, 'Recreating the proxy must not repeat migration');
  restored.editor.editBuiltin('ram');
  assert.equal(restored.editor.currentMetric.command, 'printf 43');
  assert.equal(restored.editor.currentMetric.detailCommand, 'printf available');
  restored.editor.restoreBuiltin('ram');
  assert.equal(restored.config.store.plugin.serverStats.defaultMetricOverrides.ram, undefined);
  restored.editor.editBuiltin('ram');
  restored.editor.currentMetric.command = 'printf 44';
  restored.editor.saveMetric(true);
  assert.equal(restored.snapshot.plugin.serverStats.defaultMetricOverrides.ram.command, 'printf 44');
});

test('built-in order and visibility survive reconstruction from host raw config', () => {
  const fixture = hostSettingsFixture();
  fixture.editor.moveBuiltin('load', -1);
  fixture.editor.moveBuiltin('load', -1);
  fixture.editor.toggleBuiltinEnabled('ram');
  fixture.editor.toggleBuiltinEnabled('net');
  assert.equal(fixture.raw.plugin.serverStats.builtinOrder.join(','), 'load,ram,net');
  const reopened = hostSettingsFixture(fixture.snapshot);
  assert.equal(reopened.editor.builtinKeys.join(','), 'load,ram,net');
  assert.equal(reopened.config.store.plugin.serverStats.defaultMetrics.ram, false);
  assert.equal(reopened.config.store.plugin.serverStats.defaultMetrics.net, false);
  assert.equal(reopened.config.store.plugin.serverStats.defaultMetrics.load, true);
  assert.equal(reopened.saves, 0);
});

test('host migration preserves custom groups and edited legacy labels without repeating on reopen', () => {
  const group = {
    id: 'saved-load', label: 'Lab load', enabled: false, mode: 'carousel', layout: 'horizontal',
    main: { id: 'main', label: 'Threads', type: 'text', command: 'printf custom-main' },
    children: [{ id: 'child', label: 'Load', type: 'text', command: 'printf custom-child' }],
    displayScope: { mode: 'selected', profileIds: ['saved-pane'] },
    presetOrigin: { kind: 'group', id: 'cpu-load-group', source: 'https://github.com/lishuainan0209/tabby-group-server-stats' },
  };
  const raw = { plugin: { serverStats: {
    defaultMetrics: { cpu: true, disk: false, ram: false },
    defaultMetricOverrides: { disk: { id: 'builtin-disk', label: 'Archive', type: 'text', command: 'printf 91',
      displayScope: { mode: 'selected', profileIds: ['disk-pane'] } } },
    customMetrics: [{ id: 'existing', label: 'Existing', type: 'text', command: 'printf 1' }], metricGroups: [group],
  } } };
  const original = JSON.stringify(group);
  const fixture = hostSettingsFixture(raw);
  assert.equal(JSON.stringify(raw.plugin.serverStats.metricGroups[0]), original);
  const metrics = fixture.config.store.plugin.serverStats.customMetrics;
  assert.equal(metrics.length, 3);
  assert.equal(metrics[1].enabled, true);
  assert.equal(metrics[2].enabled, false);
  assert.equal(metrics[2].command, 'printf 91');
  assert.equal(metrics[2].displayScope.profileIds[0], 'disk-pane');
  assert.equal(fixture.config.store.plugin.serverStats.defaultMetrics.load, false);
  const reopened = hostSettingsFixture(fixture.snapshot);
  assert.equal(reopened.config.store.plugin.serverStats.customMetrics.length, 3);
  assert.equal(JSON.stringify(reopened.config.store.plugin.serverStats.metricGroups[0]), original);
  assert.equal(reopened.saves, 0);
});

function layoutScopeFixture() {
  const fixture = scopeFixture();
  const leaf = id => ({ type: 'app:ssh-tab', profile: { id, type: 'ssh', name: id === 'shared' ? 'Repeated connection' : 'Other connection' } });
  fixture.config.store.profiles = [
    { id: 'shared', type: 'ssh', name: 'Repeated connection' },
    { id: 'different-id', type: 'ssh', name: 'Repeated connection' },
    { id: 'layout-a', type: 'split-layout', name: 'Layout A', options: { recoveryToken: { type: 'app:split-tab', children: [leaf('shared'), leaf('shared'), leaf('deleted')] } } },
    { id: 'layout-b', type: 'split-layout', name: 'Layout B', options: { recoveryToken: { type: 'app:split-tab', children: [leaf('shared')] } } },
  ];
  fixture.editor.setScopeMode('selected');
  return fixture;
}

test('layout scopes default expanded, include deleted originals and collapse/search without changing selections', () => {
  const { editor } = layoutScopeFixture();
  const panes = editor.scopeChoices.filter(p => p.layoutId);
  assert.equal(panes.length, 4);
  assert.equal(new Set(panes.map(p => p.id)).size, 4);
  assert.equal(panes.filter(p => p.profileId === 'deleted').length, 1);
  editor.toggleScopeProfile(panes[0].id, true);
  const selection = JSON.stringify(editor.scopeOwner.displayScope);
  editor.toggleScopeLayout('layout-a');
  assert.equal(editor.scopeChoices.filter(p => p.layoutId === 'layout-a').length, 0);
  editor.scopeSearch = 'Other connection';
  assert.equal(editor.scopeChoices.length, 2, 'search retains parent and matching child even when collapsed');
  assert.equal(editor.scopeChoices[0].id, 'layout-a');
  assert.equal(JSON.stringify(editor.scopeOwner.displayScope), selection);
});

test('checking one repeated connection selects all exact-ID entries and unchecking cancels only that pane', () => {
  const { editor } = layoutScopeFixture();
  const panes = editor.scopeChoices.filter(p => p.profileId === 'shared');
  editor.toggleScopeProfile(panes[0].id, true);
  assert(editor.isScopeSelected('shared'));
  assert(!editor.isScopeSelected('different-id'), 'equal labels do not link unrelated connections');
  assert(panes.every(p => editor.isScopeSelected(p.id)));
  editor.toggleScopeProfile(panes[1].id, false);
  assert(!editor.isScopeSelected(panes[1].id));
  assert(editor.isScopeSelected('shared'));
  assert(editor.isScopeSelected(panes[0].id));
  assert(editor.isScopeSelected(panes[2].id));
  editor.toggleScopeProfile('shared', false);
  assert(!editor.isScopeSelected('shared'));
  assert(editor.isScopeSelected(panes[0].id));
  assert(editor.isScopeSelected(panes[2].id));
  editor.toggleScopeProfile(panes[1].id, true);
  assert(panes.every(p => editor.isScopeSelected(p.id)));
  assert(editor.isScopeSelected('shared'));
});

test('a layout-wide scope respects per-pane exclusions after save and reopen', () => {
  const { editor, config } = layoutScopeFixture();
  editor.editMetric(0);
  editor.setScopeMode('selected');
  const children = editor.scopeChoices.filter(p => p.layoutId === 'layout-a');
  editor.toggleScopeProfile('layout-a', true);
  assert(children.every(p => editor.isScopeSelected(p.id)));
  editor.toggleScopeProfile(children[0].id, false);
  assert(!editor.isScopeSelected(children[0].id));
  assert(editor.isScopeIndeterminate('layout-a'));
  assert(!editor.isScopeSelected('layout-a'));
  editor.saveMetric(true);
  editor.editMetric(0);
  assert(!editor.isScopeSelected(children[0].id));
  assert(editor.isScopeSelected(children[1].id));
  const scope = config.store.plugin.serverStats.customMetrics[0].displayScope;
  const match = mocks['../display-scope'].matchesScope;
  assert(!match(scope, { profileIds: ['shared', 'layout-a', children[0].id] }, config.store.profiles));
  assert(match(scope, { profileIds: ['shared', 'layout-a', children[1].id] }, config.store.profiles));
  assert.equal(scope.profileNames[children[0].id], children[0].storedName);
});

test('clearing a layout clears only its own pane entries even with a shared connection selected', () => {
  const { editor } = layoutScopeFixture();
  const shared = editor.scopeChoices.filter(p => p.profileId === 'shared');
  editor.toggleScopeProfile('shared', true);
  editor.toggleScopeProfile('layout-a', false);
  assert(shared.filter(p => p.layoutId === 'layout-a').every(p => !editor.isScopeSelected(p.id)));
  assert(editor.isScopeSelected(shared.find(p => p.layoutId === 'layout-b').id));
  assert(editor.isScopeSelected('shared'));
  editor.toggleScopeProfile('layout-a', true);
  assert(editor.scopeChoices.filter(p => p.layoutId === 'layout-a').every(p => editor.isScopeSelected(p.id)));
});

test('unchecking a legacy standalone connection preserves its already selected layout occurrences', () => {
  const { editor } = layoutScopeFixture();
  const panes = editor.scopeChoices.filter(p => p.profileId === 'shared');
  editor.scopeOwner.displayScope = { mode: 'selected', profileIds: ['shared'] };
  assert(panes.every(p => editor.isScopeSelected(p.id)));
  editor.toggleScopeProfile('shared', false);
  assert(!editor.isScopeSelected('shared'));
  assert(panes.every(p => editor.isScopeSelected(p.id)));
  assert.equal(editor.scopeOwner.displayScope.profileIds.length, 3);
});

test('deleted standalone selections do not falsely check their retained layout copies', () => {
  const { editor } = layoutScopeFixture();
  const pane = editor.scopeChoices.find(p => p.profileId === 'deleted');
  editor.scopeOwner.displayScope = { mode: 'selected', profileIds: ['deleted'] };
  assert(!editor.isScopeSelected(pane.id));
  editor.toggleScopeProfile(pane.id, true);
  assert(editor.isScopeSelected(pane.id));
});

test('bottom status bar settings have a bilingual title and enabled switch without display-mode controls', () => {
  assert(componentMetadata.template.includes('<h3 translate>Bottom Status Bar</h3>'));
  assert(componentMetadata.template.includes('id="statusBarEnabled"'));
  assert(!componentMetadata.template.includes('displayModeFloating'));
  assert(!componentMetadata.template.includes('floating panel'));
  const translations = mocks['../translations'].TRANSLATIONS;
  assert.equal(translations['zh-CN']['Bottom Status Bar'], '底部状态栏');
  assert.equal(translations.en['Bottom Status Bar'], 'Bottom Status Bar');
});

test('new singles, group mains and children default to text values and output-text checks', () => {
  const { editor } = scopeFixture();
  const assertDefaults = metric => {
    assert.equal(metric.type, 'text');
    assert.equal(metric.checkMode, 'output');
    assert.equal(metric.checkExpected, '');
    assert.equal(metric.showWhenUnavailable, true);
  };
  assertDefaults(editor.currentMetric);
  editor.newGroup();
  assertDefaults(editor.currentGroup.main);
  editor.addChild();
  assertDefaults(editor.currentGroup.children[0]);
  editor.cancelEdit();
  assertDefaults(editor.currentMetric);
});

test('editing preserves explicit modes and legacy missing check modes retain exit-code semantics', () => {
  const { config, editor } = scopeFixture();
  const metric = config.store.plugin.serverStats.customMetrics[0];
  Object.assign(metric, { type: 'progress', checkCommand: 'test -d /data', checkExpected: '0' });
  editor.editMetric(0);
  assert.equal(editor.currentMetric.type, 'progress');
  assert.equal(editor.currentMetric.checkMode, 'exitCode');
  assert.equal(metric.checkMode, undefined, 'Opening the draft must not rewrite saved config');
  editor.saveMetric(true);
  assert.equal(config.store.plugin.serverStats.customMetrics[0].checkMode, 'exitCode');
  Object.assign(config.store.plugin.serverStats.customMetrics[0], { checkMode: 'output', checkExpected: 'exists' });
  editor.editMetric(0);
  assert.equal(editor.currentMetric.checkMode, 'output');
  assert.equal(editor.currentMetric.checkExpected, 'exists');
});

test('Ctrl+S saves the group, collapses only the active member and keeps navigation open', () => {
  const { config, editor } = scopeFixture();
  editor.newGroup();
  Object.assign(editor.currentMetric, { label: 'Main', command: 'printf main' });
  const main = editor.currentMetric;
  editor.addChild();
  Object.assign(editor.currentMetric, { label: 'Child', command: 'printf child' });
  const child = editor.currentMetric;
  let prevented = false;
  editor.onEditorKeydown({ ctrlKey: true, key: 's', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert(prevented);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].children[0].command, 'printf child');
  assert(editor.expandedMembers.has(main.id));
  assert(!editor.expandedMembers.has(child.id));
  assert(editor.editorOpen);
  editor.navigateMember(0);
  child.command = 'printf updated';
  editor.activateMetric(main);
  editor.onEditorKeydown({ ctrlKey: true, key: 'S', preventDefault() {}, stopPropagation() {} });
  assert(!editor.expandedMembers.has(main.id));
  assert(editor.expandedMembers.has(child.id));
  assert.equal(config.store.plugin.serverStats.metricGroups.length, 1, 'Repeated saves do not duplicate new groups');
  assert.equal(config.store.plugin.serverStats.metricGroups[0].children[0].command, 'printf updated');
  editor.toggleGroupMetric(0);
  assert.equal(editor.currentMetric.id, child.id, 'Collapsing a heading also makes that member the shortcut target');
});

test('navigator closing supports saving, discarding and keeping invalid drafts open', () => {
  const { config, editor } = scopeFixture();
  editor.newSingle();
  editor.requestEditorClose();
  assert(editor.closePrompt);
  editor.finishEditorClose(true);
  assert(editor.editorOpen, 'Invalid drafts cannot be silently discarded by Save and close');
  Object.assign(editor.currentMetric, { label: 'Single', command: 'printf 1' });
  editor.finishEditorClose(true);
  assert(!editor.editorOpen);
  editor.editMetric(0);
  editor.currentMetric.command = 'printf lost';
  editor.requestEditorClose();
  editor.finishEditorClose(false);
  assert(!editor.editorOpen);
  assert.equal(config.store.plugin.serverStats.customMetrics[0].command, 'printf 1');
  editor.editMetric(0);
  editor.saveMetric();
  assert(editor.editorOpen);
  assert(!editor.singleExpanded);
  editor.navigateMember();
  assert(editor.singleExpanded);
});

test('member accordion collapse and switching preserve drafts, scope and selected metric identity', () => {
  const { editor } = scopeFixture();
  editor.newGroup();
  Object.assign(editor.currentMetric, { label: 'Main', command: 'printf main' });
  const mainId = editor.currentMetric.id;
  editor.toggleScopeProfile('ssh:p1', true);
  editor.addChild();
  Object.assign(editor.currentMetric, { label: 'Disk', command: 'printf child', detailCommand: 'printf details' });
  const childId = editor.currentMetric.id;
  editor.toggleGroupMetric(0);
  assert.equal(editor.expandedMemberId, null);
  assert.equal(editor.currentMetric.id, childId);
  assert(editor.expandedMembers.has(mainId), 'Opening a child does not close the main');
  editor.selectGroupMetric(-1);
  assert.equal(editor.expandedMemberId, mainId);
  assert.equal(editor.currentMetric.command, 'printf main');
  editor.toggleGroupMetric(0);
  assert.equal(editor.expandedMemberId, childId);
  assert.equal(editor.currentMetric.detailCommand, 'printf details');
  assert.equal(editor.isScopeSelected('ssh:p1'), true);
  editor.saveGroup(true);
  editor.editGroup(0);
  assert.equal(editor.currentGroup.children[0].id, childId);
  assert.equal(editor.currentGroup.children[0].detailCommand, 'printf details');
});

test('reordering a collapsed child keeps its draft identity and the editor collapsed', () => {
  const { editor } = scopeFixture();
  editor.newGroup();
  editor.addChild();
  const firstId = editor.currentMetric.id;
  editor.currentMetric.label = 'First';
  editor.addChild();
  const secondId = editor.currentMetric.id;
  editor.currentMetric.label = 'Second';
  editor.toggleGroupMetric(1);
  editor.moveChild(1, -1);
  assert.equal(editor.expandedMemberId, null);
  assert.equal(editor.currentMetric.id, secondId);
  assert.equal(editor.editingChildIndex, 0);
  assert.equal(editor.currentGroup.children[1].id, firstId);
  editor.toggleGroupMetric(0);
  assert.equal(editor.currentMetric.label, 'Second');
  editor.removeChild(0);
  assert.equal(editor.currentMetric.id, editor.currentGroup.main.id);
  assert.equal(editor.expandedMemberId, editor.currentGroup.main.id);
});

test('group pencil editing starts collapsed and repeat clicks preserve open members and drafts', () => {
  const { config, editor } = scopeFixture();
  editor.newGroup();
  Object.assign(editor.currentMetric, { label: 'Main', command: 'printf main' });
  editor.currentGroup.label = 'Stored';
  editor.saveGroup(true);
  editor.editGroup(0);
  assert.equal(editor.expandedMemberId, null);
  editor.toggleGroupMetric(-1);
  assert.equal(editor.expandedMemberId, editor.currentGroup.main.id);
  editor.currentGroup.label = 'Draft';
  editor.currentMetric.command = 'printf edited';
  editor.iconPickerOpen = true;
  editor.editGroup(0);
  assert.equal(editor.expandedMemberId, editor.currentGroup.main.id);
  assert.equal(editor.iconPickerOpen, false);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].label, 'Stored');
  assert.equal(editor.currentGroup.label, 'Draft');
  assert.equal(editor.currentMetric.command, 'printf edited');
  editor.cancelEdit();
  assert.equal(editor.currentGroup, null);
  assert.equal(editor.editingGroupId, null);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].label, 'Stored');
});

test('new groups open the main form immediately while existing built-in network editing starts collapsed', () => {
  const { config, editor } = scopeFixture();
  editor.newGroup();
  assert.equal(editor.expandedMemberId, editor.currentGroup.main.id);
  assert.equal(editor.currentMetric.id, editor.currentGroup.main.id);
  editor.editBuiltin('net');
  assert.equal(editor.expandedMemberId, null);
  assert.equal(editor.currentGroup.id, 'builtin-net');
  editor.toggleGroupMetric(0);
  assert.equal(editor.expandedMemberId, editor.currentGroup.children[0].id);
  const draft = editor.currentGroup;
  const child = editor.currentMetric;
  child.command = 'printf pending';
  editor.iconPickerOpen = true;
  editor.editBuiltin('net');
  assert.equal(editor.currentGroup, draft);
  assert.equal(editor.currentMetric, child);
  assert.equal(editor.expandedMemberId, null);
  assert.equal(editor.iconPickerOpen, false);
  assert.equal(config.store.plugin.serverStats.defaultMetricOverrides, undefined);
  editor.toggleGroupMetric(0);
  assert.equal(editor.expandedMemberId, child.id);
  assert.equal(editor.currentMetric.command, 'printf pending');
});

function groupCardFixture() {
  const fixture = scopeFixture();
  fixture.config.store.plugin.serverStats.metricGroups = [0, 1].map(index => ({
    id: `group-${index}`, label: `Disks ${index}`, mode: 'overview', layout: 'vertical',
    main: { id: `main-${index}`, label: 'Total', command: `printf ${100 + index}`, type: 'text' },
    children: [0, 1].map(child => ({
      id: `child-${index}-${child}`, label: 'Disk', command: `printf ${child}`, type: 'text',
    })),
  }));
  return fixture;
}

test('group summary chips open the exact main or child editor without discarding same-group drafts', () => {
  const { config, editor } = groupCardFixture();
  editor.editGroupMember(1, 1);
  assert.equal(editor.editingGroupId, 'group-1');
  assert.equal(editor.editingChildIndex, 1);
  assert.equal(editor.currentMetric.id, 'child-1-1', 'Equal child names must not select the wrong child');
  assert.equal(editor.expandedMemberId, 'child-1-1');
  editor.currentMetric.command = 'printf changed';
  editor.editGroupMember(1);
  assert.equal(editor.currentMetric.id, 'main-1');
  assert.equal(editor.expandedMemberId, 'main-1');
  editor.editGroupMember(1, 1);
  assert.equal(editor.currentMetric.command, 'printf changed');
  assert.equal(config.store.plugin.serverStats.metricGroups[1].children[1].command, 'printf 1');
  const draft = editor.currentGroup;
  for (const [group, child] of [[99, 0], [1, 99], [1, -2]]) editor.editGroupMember(group, child);
  assert.equal(editor.currentGroup, draft, 'Invalid card/member targets must leave the editor intact');
  assert.equal(editor.currentMetric.id, 'child-1-1');
});

test('child deletion requires a named confirmation, cancellation preserves its draft, and acceptance waits for Save Group', () => {
  for (const language of ['en', 'zh-CN']) {
    const { config, editor } = groupCardFixture();
    config.store.language = language;
    let saveCalls = 0;
    config.save = () => saveCalls++;
    editor.editGroupMember(0, 1);
    editor.currentMetric.label = 'Data disk draft';
    editor.currentMetric.command = 'printf draft';
    const selected = editor.currentMetric;
    const before = JSON.stringify(editor.currentGroup);
    withConfirmation(false, messages => {
      editor.removeChild(1);
      assert.equal(messages.length, 1);
      assert.match(messages[0], language === 'en' ? /Delete this child metric\?/ : /删除此子标签/);
      assert.ok(messages[0].endsWith(' / Data disk draft'));
      assert.ok(messages[0].includes(editor.currentGroup.label));
    });
    assert.equal(editor.currentMetric, selected);
    assert.equal(editor.expandedMemberId, 'child-0-1');
    assert.equal(JSON.stringify(editor.currentGroup), before);
    assert.equal(saveCalls, 0);
    withConfirmation(true, messages => {
      editor.removeChild(1);
      assert.equal(messages.length, 1);
    });
    assert.equal(editor.currentGroup.children.length, 1);
    assert.equal(editor.currentGroup.children[0].id, 'child-0-0');
    assert.equal(editor.currentMetric.id, 'main-0', 'Deleting the active child returns to its main metric');
    assert.equal(config.store.plugin.serverStats.metricGroups[0].children.length, 2);
    assert.equal(saveCalls, 0, 'Confirming child removal edits only the pending group draft');
    editor.saveGroup(true);
    assert.equal(config.store.plugin.serverStats.metricGroups[0].children.length, 1);
    assert.equal(config.store.plugin.serverStats.metricGroups[1].children.length, 2);
    assert.equal(saveCalls, 1);
  }
});

test('group deletion cancellation keeps configuration and the active draft, then confirmation removes only the named group', () => {
  const { config, editor } = groupCardFixture();
  let saveCalls = 0;
  config.save = () => saveCalls++;
  editor.editGroupMember(0, 1);
  editor.currentMetric.command = 'printf pending';
  const draft = editor.currentGroup;
  const selected = editor.currentMetric;
  const before = JSON.stringify(config.store.plugin.serverStats);
  withConfirmation(false, messages => {
    editor.removeGroup(0);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Delete this group and all of its metrics\?/);
    assert.ok(messages[0].endsWith('\n\nDisks 0'));
  });
  assert.equal(JSON.stringify(config.store.plugin.serverStats), before);
  assert.equal(editor.currentGroup, draft);
  assert.equal(editor.currentMetric, selected);
  assert.equal(editor.expandedMemberId, 'child-0-1');
  assert.equal(saveCalls, 0);
  withConfirmation(true, messages => {
    editor.removeGroup(0);
    assert.equal(messages.length, 1);
  });
  assert.equal(config.store.plugin.serverStats.metricGroups.length, 1);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].id, 'group-1');
  assert.equal(config.store.plugin.serverStats.customMetrics[0].id, 'legacy');
  assert.equal(editor.currentGroup, null);
  assert.equal(editor.editingGroupId, null);
  assert.equal(saveCalls, 1);
});

test('single-label deletion cancellation preserves edits and confirmation removes only the targeted label', () => {
  const { config, editor } = scopeFixture();
  config.store.language = 'zh-CN';
  config.store.plugin.serverStats.customMetrics.push({ id: 'second', label: 'Second', command: 'printf 2', type: 'text' });
  let saveCalls = 0;
  config.save = () => saveCalls++;
  editor.editMetric(0);
  editor.currentMetric.command = 'printf pending';
  const draft = editor.currentMetric;
  withConfirmation(false, messages => {
    editor.removeMetric(0);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /确定删除此标签/);
    assert.ok(messages[0].endsWith('\n\nLegacy'));
  });
  assert.equal(config.store.plugin.serverStats.customMetrics.length, 2);
  assert.equal(config.store.plugin.serverStats.customMetrics[0].command, 'printf 1');
  assert.equal(editor.currentMetric, draft);
  assert.equal(editor.currentMetric.command, 'printf pending');
  assert.equal(editor.editingIndex, 0);
  assert.equal(saveCalls, 0);
  withConfirmation(true, messages => {
    editor.removeMetric(0);
    assert.equal(messages.length, 1);
  });
  assert.equal(config.store.plugin.serverStats.customMetrics.length, 1);
  assert.equal(config.store.plugin.serverStats.customMetrics[0].id, 'second');
  assert.equal(editor.editingIndex, -1);
  assert.equal(saveCalls, 1);
});

test('new single form starts hidden and closes after cancel/save or switching to a group', () => {
  const { config, editor } = scopeFixture();
  assert.equal(editor.newSingleOpen, false);
  editor.newSingle();
  assert.equal(editor.newSingleOpen, true);
  assert.equal(editor.currentMetric.type, 'text');
  assert.equal(editor.currentMetric.checkMode, 'output');
  editor.currentMetric.label = 'Discard';
  editor.cancelEdit();
  assert.equal(editor.newSingleOpen, false);
  assert.equal(config.store.plugin.serverStats.customMetrics.length, 1);
  editor.newSingle();
  assert.notEqual(editor.currentMetric.label, 'Discard');
  Object.assign(editor.currentMetric, { label: 'Added', command: 'printf 1' });
  editor.saveMetric(true);
  assert.equal(editor.newSingleOpen, false);
  assert.equal(config.store.plugin.serverStats.customMetrics.length, 2);
  assert.equal(config.store.plugin.serverStats.customMetrics[1].type, 'text');
  editor.newSingle();
  editor.newGroup();
  assert.equal(editor.newSingleOpen, false);
  assert.ok(editor.currentGroup);
  editor.cancelEdit();
  assert.equal(editor.newSingleOpen, false);
  editor.editMetric(0);
  assert.equal(editor.newSingleOpen, false);
  assert.equal(editor.editingIndex, 0);
});

test('icon picker searches purpose keywords and labels while combining category filters', () => {
  const { editor } = scopeFixture();
  editor.iconPresets = [
    { name: 'metric-io-wait', label: 'I/O 等待', category: 'Compute', keywords: ['cpu', 'IO wait', '等待'] },
    { name: 'metric-system-disk', label: '系统盘', category: 'Storage', keywords: 'root disk filesystem' },
    { name: 'server', label: 'Server' },
  ];
  assert.equal(editor.iconCategories.join(','), 'Compute,Storage,Other');
  editor.iconSearch = '  CPU WAIT  ';
  assert.equal(editor.filteredIconPresets.map(icon => icon.name).join(','), 'metric-io-wait');
  editor.iconCategory = 'Storage';
  assert.equal(editor.filteredIconPresets.length, 0);
  editor.iconSearch = '系统';
  assert.equal(editor.filteredIconPresets[0].name, 'metric-system-disk');
  editor.iconSearch = 'filesystem';
  assert.equal(editor.filteredIconPresets[0].name, 'metric-system-disk');
  editor.iconCategory = 'Other';
  editor.iconSearch = '';
  assert.equal(editor.filteredIconPresets[0].name, 'server');
});

test('icon search keeps a custom icon intact and selecting a preset only changes the draft', () => {
  const { config, editor } = scopeFixture();
  config.store.plugin.serverStats.customMetrics[0].icon = 'data:image/svg+xml;base64,custom';
  editor.editMetric(0);
  editor.iconSearch = 'CPU';
  editor.iconCategory = 'Compute';
  assert.equal(editor.currentMetric.icon, 'data:image/svg+xml;base64,custom');
  editor.iconPickerOpen = true;
  editor.selectPresetIcon('metric-cpu');
  assert.equal(editor.currentMetric.icon, 'metric-cpu');
  assert.equal(editor.iconPickerOpen, false);
  assert.equal(config.store.plugin.serverStats.customMetrics[0].icon, 'data:image/svg+xml;base64,custom');
  editor.cancelEdit();
  assert.equal(editor.iconSearch, '');
  assert.equal(editor.iconCategory, 'all');
  assert.equal(config.store.plugin.serverStats.customMetrics[0].icon, 'data:image/svg+xml;base64,custom');
});

test('enable toggles preserve command/rules and group members remain drafts until saved', () => {
  const { config, editor } = scopeFixture();
  const original = config.store.plugin.serverStats.customMetrics[0];
  original.colorRules = [{ operator: '>', value: '50', color: '#ff0000' }];
  editor.toggleMetricEnabled(0);
  assert.equal(original.enabled, false);
  assert.equal(original.command, 'printf 1');
  assert.equal(original.colorRules[0].value, '50');
  editor.toggleMetricEnabled(0);
  assert.equal(original.enabled, true);
  editor.newGroup();
  Object.assign(editor.currentMetric, { label: 'Main', command: 'printf 1' });
  editor.addChild();
  Object.assign(editor.currentMetric, { label: 'Child', command: 'printf 2' });
  editor.saveGroup(true);
  editor.toggleGroupEnabled(0);
  const group = config.store.plugin.serverStats.metricGroups[0];
  assert.equal(group.enabled, false);
  assert.equal(group.children[0].command, 'printf 2');
  editor.editGroup(0);
  editor.toggleMemberEnabled(editor.currentGroup.children[0]);
  assert.notEqual(group.children[0].enabled, false);
  editor.saveGroup(true);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].children[0].enabled, false);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].enabled, false);
});

test('saving a disk I/O label preserves its value protocol and percentage color rules', () => {
  const { config, editor } = scopeFixture();
  const metric = config.store.plugin.serverStats.customMetrics[0];
  Object.assign(metric, { valueFormat: 'disk-io-rate', suffix: 'MB/s', command: 'printf TABBY-IO:3.00:96.00',
    colorRules: [{ operator: '>=', value: '95', color: '#ff0000' }, { operator: '>=', value: '80', color: '#ffa500' }] });
  editor.editMetric(0);
  assert.equal(editor.currentMetric.valueFormat, 'disk-io-rate');
  editor.currentMetric.label = 'Read/write';
  editor.currentMetric.colorRules[1].value = '75';
  assert.equal(metric.colorRules[1].value, '80', 'Rule editing stays in the draft');
  editor.saveMetric(true);
  const stored = config.store.plugin.serverStats.customMetrics[0];
  assert.equal(stored.valueFormat, 'disk-io-rate');
  assert.equal(stored.suffix, 'MB/s');
  assert.equal(stored.command, 'printf TABBY-IO:3.00:96.00');
  assert.equal(stored.colorRules[1].value, '75');
  editor.editMetric(0);
  assert.equal(editor.currentMetric.valueFormat, 'disk-io-rate');
  assert.equal(editor.currentMetric.colorRules[1].value, '75');
});

test('group editing and child reordering retain disk I/O protocol metadata on the right members', () => {
  const { config, editor } = scopeFixture();
  editor.newGroup();
  Object.assign(editor.currentMetric, { label: 'Total I/O', valueFormat: 'disk-io-rate', suffix: 'MB/s', command: 'printf TABBY-IO:50:80' });
  const mainId = editor.currentMetric.id;
  editor.addChild();
  Object.assign(editor.currentMetric, { label: '/data', valueFormat: 'disk-io-rate', suffix: 'MB/s', command: 'printf TABBY-IO:50:80' });
  const ioId = editor.currentMetric.id;
  editor.addChild();
  Object.assign(editor.currentMetric, { label: 'Ordinary', command: 'printf 50' });
  const ordinaryId = editor.currentMetric.id;
  editor.moveChild(1, -1);
  editor.saveGroup(true);
  const stored = config.store.plugin.serverStats.metricGroups[0];
  assert.equal(stored.main.id, mainId);
  assert.equal(stored.main.valueFormat, 'disk-io-rate');
  assert.equal(stored.children[0].id, ordinaryId);
  assert.equal(stored.children[0].valueFormat, undefined);
  assert.equal(stored.children[1].id, ioId);
  assert.equal(stored.children[1].valueFormat, 'disk-io-rate');
  editor.editGroup(0);
  editor.selectGroupMetric(1);
  assert.equal(editor.currentMetric.valueFormat, 'disk-io-rate');
});

test('hiding a failed child disables carousel participation without changing its check', () => {
  const { editor } = scopeFixture();
  editor.newGroup();
  Object.assign(editor.currentMetric, { label: 'Main', command: 'printf 1' });
  editor.addChild();
  Object.assign(editor.currentMetric, { label: 'Child', command: 'printf 2', checkCommand: 'printf exists', checkExpected: 'exists' });
  assert.equal(editor.currentMetric.visibleWhenUnavailable, true);
  editor.setUnavailableVisibility(false);
  assert.equal(editor.currentMetric.visibleWhenUnavailable, false);
  assert.equal(editor.currentMetric.showWhenUnavailable, false);
  editor.setUnavailableVisibility(true);
  assert.equal(editor.currentMetric.showWhenUnavailable, false, 'Showing again must not silently opt back into carousel');
  assert.equal(editor.currentMetric.checkCommand, 'printf exists');
  assert.equal(editor.currentMetric.checkExpected, 'exists');
});

test('built-in editing is a draft and restoring one item preserves other overrides and enable flags', () => {
  const { config, editor } = scopeFixture();
  const conf = config.store.plugin.serverStats;
  conf.defaultMetrics = { ram: false, net: true, load: true };
  editor.editBuiltin('ram');
  const original = editor.currentMetric.command;
  editor.currentMetric.command = 'printf 7';
  assert.equal(conf.defaultMetricOverrides, undefined);
  editor.cancelEdit();
  editor.editBuiltin('ram');
  assert.equal(editor.currentMetric.command, original);
  editor.currentMetric.command = 'printf 8';
  editor.saveMetric(true);
  assert.equal(conf.defaultMetricOverrides.ram.command, 'printf 8');
  assert.equal(conf.defaultMetrics.ram, false);
  assert.equal(conf.customMetrics.length, 1);
  editor.editBuiltin('load');
  editor.selectGroupMetric(-1);
  editor.currentMetric.command = 'printf 9';
  editor.saveMetric(true);
  editor.restoreBuiltin('ram');
  assert.equal(conf.defaultMetricOverrides.ram, undefined);
  assert.equal(conf.defaultMetricOverrides.load.main.command, 'printf 9');
  assert.equal(conf.defaultMetrics.ram, false);
  assert.equal(conf.customMetrics[0].id, 'legacy');
});

test('built-in network group saves overrides independently of custom groups', () => {
  const { config, editor } = scopeFixture();
  editor.editBuiltin('net');
  assert.equal(editor.currentGroup.id, 'builtin-net');
  editor.selectGroupMetric(0);
  editor.currentMetric.command = 'printf 12';
  editor.currentMetric.color = '#ff1122';
  editor.saveGroup(true);
  const conf = config.store.plugin.serverStats;
  assert.equal(conf.defaultMetricOverrides.net.children[0].command, 'printf 12');
  assert.equal(conf.defaultMetricOverrides.net.children[0].color, '#ff1122');
  assert.equal(conf.metricGroups.length, 0);
  editor.restoreBuiltin('net');
  assert.equal(conf.defaultMetricOverrides.net, undefined);
});

test('built-in order persists across settings instances without changing definitions or enabled flags', () => {
  const { config, editor } = scopeFixture();
  const conf = config.store.plugin.serverStats;
  conf.defaultMetrics = { cpu: false, ram: true, disk: false, net: true };
  conf.defaultMetricOverrides = { ram: { label: 'Custom RAM', command: 'printf 42', colorRules: [{ operator: '>', value: '90', color: '#ff0000' }] } };
  const unchanged = JSON.stringify({ flags: conf.defaultMetrics, overrides: conf.defaultMetricOverrides });
  editor.moveBuiltin('net', -1);
  editor.moveBuiltin('net', -1);
  editor.moveBuiltin('net', -1);
  assert.equal(editor.builtinKeys.join(','), 'net,ram,load');
  assert.equal(conf.builtinOrder.join(','), 'net,ram,load');
  assert.equal(JSON.stringify({ flags: conf.defaultMetrics, overrides: conf.defaultMetricOverrides }), unchanged);
  editor.moveBuiltin('net', -1);
  assert.equal(conf.builtinOrder.join(','), 'net,ram,load');
  const reopened = new exportsObject.ServerStatsSettingsComponent({}, config, {});
  assert.equal(reopened.builtinKeys.join(','), 'net,ram,load');
  editor.restoreBuiltin('ram');
  assert.equal(conf.builtinOrder.join(','), 'net,ram,load');
  assert.equal(conf.defaultMetrics.cpu, false);
});

test('successful library imports preserve earlier choices and update repeated IDs without enabling them', () => {
  const { config, editor } = scopeFixture();
  const beforeConfig = JSON.stringify(config.store.plugin);
  const make = (id, label) => ({ id, kind: 'metric', label, metric: { id: `${id}-metric`, label, type: 'text', command: 'printf 1' } });
  editor.loadPresetLibrary([make('remote-first', 'First')]);
  editor.loadPresetLibrary([make('remote-next', 'Next')]);
  editor.loadPresetLibrary([make('remote-first', 'First updated')]);
  assert.equal(editor.presets.filter(p => p.id === 'remote-first').length, 1);
  assert.equal(editor.presets.find(p => p.id === 'remote-first').label, 'First updated');
  assert(editor.presets.some(p => p.id === 'remote-next'));
  assert(editor.presets.length > 2, 'Bundled choices remain');
  assert.equal(JSON.stringify(config.store.plugin), beforeConfig, 'Preview imports do not persist or activate commands');
});

test('preset library import only previews; repeated additions are blocked and missing targets stay restricted', () => {
  const { config, editor } = scopeFixture();
  const imported = [{ id: 'lab', kind: 'group', label: 'Lab disks', profileNames: ['Missing machine'], group: {
    id: 'group-original', label: 'Lab disks', mode: 'overview', layout: 'vertical',
    main: { id: 'main-original', label: 'Main', type: 'text', command: 'printf 1' },
    children: [{ id: 'child-original', label: 'Data', type: 'text', command: 'printf 2' }],
  } }];
  editor.loadPresetLibrary(imported);
  assert.equal(config.store.plugin.serverStats.metricGroups.length, 0);
  editor.addPreset(editor.presets[0]);
  editor.addPreset(editor.presets[0]);
  const groups = config.store.plugin.serverStats.metricGroups;
  const ids = groups.flatMap(group => [group.id, group.main.id, ...group.children.map(child => child.id)]);
  assert.equal(groups.length, 1);
  assert.equal(new Set(ids).size, 3);
  assert.equal(editor.isPresetAdded(editor.presets[0]), true);
  assert.match(editor.presetMessage, /already added/);
  groups[0].label = 'Renamed'; groups[0].enabled = false;
  editor.addPreset(editor.presets[0]);
  assert.equal(config.store.plugin.serverStats.metricGroups.length, 1);
  assert(!ids.includes('group-original'));
  assert.equal(groups[0].displayScope.mode, 'selected');
  assert.equal(groups[0].displayScope.profileIds.length, 0);
  assert.equal(editor.presetMissingNames.join(','), 'Missing machine');
});

test('exported library uses portable profile names without connection options and keeps empty selections restricted', () => {
  const { config, editor } = scopeFixture();
  config.store.plugin.serverStats.customMetrics[0].displayScope = { mode: 'selected', profileIds: ['ssh:p1'] };
  const library = JSON.parse(editor.currentPresetLibrary());
  assert.equal(library[0].profileNames.join(','), 'P1');
  assert.equal(library[0].metric.displayScope.profileIds.length, 0);
  assert(!JSON.stringify(library).includes('ssh:p1'));
  config.store.plugin.serverStats.customMetrics[0].displayScope.profileIds = [];
  const empty = JSON.parse(editor.currentPresetLibrary());
  config.store.plugin.serverStats.customMetrics = [];
  editor.loadPresetLibrary(empty);
  editor.addPreset(editor.presets[0]);
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope.mode, 'selected');
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope.profileIds.length, 0);
});

test('export omits unnamed deleted profile IDs and reimport keeps their scope restricted', () => {
  const { config, editor } = scopeFixture();
  const metric = config.store.plugin.serverStats.customMetrics[0];
  metric.displayScope = { mode: 'selected', profileIds: ['private-deleted-id'] };
  config.store.plugin.serverStats.metricGroups = [{
    id: 'group', label: 'Disks', mode: 'overview', layout: 'vertical',
    main: { id: 'main', label: 'Root', command: 'printf 1', type: 'text' }, children: [],
    displayScope: { mode: 'selected', profileIds: ['private-deleted-group-id', 'deleted-named-id'],
      profileNames: { 'deleted-named-id': 'Former machine' } },
  }];
  const exported = editor.currentPresetLibrary();
  assert.doesNotMatch(exported, /private-deleted-id|private-deleted-group-id|deleted-named-id/);
  const library = JSON.parse(exported);
  assert.deepEqual(library[0].profileNames, []);
  assert.deepEqual(library[1].profileNames, ['Former machine']);
  assert.equal(library[0].metric.displayScope.mode, 'selected');
  editor.addPreset(library[0]);
  editor.addPreset(library[1]);
  assert.equal(editor.customMetrics[1].displayScope.mode, 'selected');
  assert.equal(editor.customMetrics[1].displayScope.profileIds.length, 0);
  assert.equal(editor.metricGroups[1].displayScope.mode, 'selected');
  assert.equal(editor.metricGroups[1].displayScope.profileIds.length, 0);
});

test('preset metadata follows English and Chinese UI language', () => {
  const { config, editor } = scopeFixture();
  const preset = { label: 'fallback', labels: { en: 'GPU memory', zh: 'GPU 显存' }, descriptions: { en: 'Free memory', zh: '剩余显存' } };
  config.store.language = 'en';
  assert.equal(editor.presetText(preset, 'label'), 'GPU memory');
  config.store.language = 'zh-CN';
  assert.equal(editor.presetText(preset, 'description'), '剩余显存');
});

test('bilingual preset metadata survives editing and export while user renames remain authoritative', () => {
  const { config, editor } = scopeFixture();
  const preset = {
    id: 'bilingual', kind: 'group', label: 'GPU 显存', labels: { en: 'GPU memory', zh: 'GPU 显存' },
    description: '剩余显存', descriptions: { en: 'Free memory', zh: '剩余显存' },
    source: { name: 'Local library', license: 'MIT' }, profileNames: [],
    group: { id: 'group', label: 'GPU 显存', mode: 'overview', layout: 'vertical',
      main: { id: 'main', label: 'GPU', command: 'printf 10', type: 'text' }, children: [] },
  };
  config.store.language = 'en';
  editor.addPreset(preset);
  assert.equal(editor.metricGroups[0].label, 'GPU memory');
  editor.editGroup(0);
  editor.currentMetric.command = 'printf 20';
  editor.saveGroup(true);
  const exported = JSON.parse(editor.currentPresetLibrary()).find(entry => entry.kind === 'group');
  assert.deepEqual(exported.labels, preset.labels);
  assert.deepEqual(exported.descriptions, preset.descriptions);
  assert.deepEqual(exported.source, preset.source);
  assert.equal(exported.group.presetMetadata, undefined);
  assert.equal(exported.group.main.command, 'printf 20');
  assert.equal(exported.group.displayScope.mode, 'selected');
  config.store.language = 'zh-CN';
  editor.addPreset(exported);
  assert.equal(editor.metricGroups.length, 1, 'Reimporting an installed preset must not duplicate it');
  config.store.plugin.serverStats.metricGroups = [];
  editor.addPreset(exported);
  assert.equal(editor.metricGroups[0].label, 'GPU 显存');
  editor.editGroup(0);
  editor.currentGroup.label = 'My custom GPU';
  editor.saveGroup(true);
  const renamed = JSON.parse(editor.currentPresetLibrary()).find(entry => entry.label === 'My custom GPU');
  assert.equal(renamed.labels, undefined);
  config.store.plugin.serverStats.metricGroups = [];
  editor.addPreset(renamed);
  assert.equal(editor.metricGroups[0].label, 'My custom GPU');
  assert.equal(editor.metricGroups[0].displayScope.profileIds.length, 0);
});

test('scope: legacy single defaults to all panes without mutating saved configuration', () => {
  const { config, editor } = scopeFixture();
  editor.editMetric(0);
  assert.equal(editor.scopeMode, 'all');
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope, undefined);
  assert.equal(editor.scopeChoices.length, 3);
  editor.cancelEdit();
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope, undefined);
});

test('scope: multi-selection is a draft, persists by ID, and all/selected toggles retain selections', () => {
  const { config, editor } = scopeFixture();
  editor.editMetric(0);
  editor.setScopeMode('selected');
  editor.toggleScopeProfile('ssh:p1', true);
  editor.toggleScopeProfile('layout:mixed', true);
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope, undefined);
  editor.setScopeMode('all');
  editor.setScopeMode('selected');
  assert.equal(editor.isScopeSelected('ssh:p1'), true);
  assert.equal(editor.isScopeSelected('layout:mixed'), true);
  editor.saveMetric(true);
  const scope = config.store.plugin.serverStats.customMetrics[0].displayScope;
  assert.equal(scope.mode, 'selected');
  assert.equal(scope.profileIds.join(','), 'ssh:p1,layout:mixed');
  assert.equal(scope.profileNames['ssh:p1'], 'P1');
  editor.editMetric(0);
  editor.removeScopeProfile('ssh:p1');
  editor.cancelEdit();
  assert.equal(scope.profileIds.join(','), 'ssh:p1,layout:mixed');
});

test('scope: group scope stays shared when switching member editors and survives save/reopen', () => {
  const { config, editor } = scopeFixture();
  editor.newGroup();
  Object.assign(editor.currentMetric, { label: 'Summary', command: 'printf 1' });
  editor.setScopeMode('selected');
  editor.toggleScopeProfile('ssh:p1', true);
  editor.addChild();
  Object.assign(editor.currentMetric, { label: 'Disk', command: 'printf 2' });
  assert.equal(editor.isScopeSelected('ssh:p1'), true);
  editor.toggleScopeProfile('ssh:p2', true);
  assert.equal(editor.currentMetric.displayScope, undefined);
  editor.selectGroupMetric(-1);
  assert.equal(editor.isScopeSelected('ssh:p2'), true);
  editor.saveGroup(true);
  const group = config.store.plugin.serverStats.metricGroups[0];
  assert.equal(group.displayScope.profileIds.join(','), 'ssh:p1,ssh:p2');
  assert.equal(group.main.displayScope, undefined);
  assert.equal(group.children[0].displayScope, undefined);
  editor.editGroup(0);
  assert.equal(editor.scopeMode, 'selected');
  editor.removeScopeProfile('ssh:p1');
  editor.cancelEdit();
  assert.equal(group.displayScope.profileIds.join(','), 'ssh:p1,ssh:p2');
});

test('scope: removing the last target preserves selected-empty rather than becoming global', () => {
  const { config, editor } = scopeFixture();
  editor.editMetric(0);
  editor.setScopeMode('selected');
  editor.toggleScopeProfile('ssh:p1', true);
  editor.removeScopeProfile('ssh:p1');
  editor.saveMetric(true);
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope.mode, 'selected');
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope.profileIds.length, 0);
  editor.editMetric(0);
  assert.equal(editor.scopeMode, 'selected');
});

test('scope: deleted target names are retained and a new same-name ID never becomes selected', () => {
  const { config, editor } = scopeFixture();
  editor.editMetric(0);
  editor.toggleScopeProfile('ssh:p1', true);
  editor.saveMetric(true);
  config.store.profiles = [{ id: 'ssh:replacement', name: 'P1', type: 'ssh' }];
  editor.editMetric(0);
  assert.equal(editor.hasMissingScopeProfiles, true);
  assert.equal(editor.scopeSelectedProfiles[0].id, 'ssh:p1');
  assert.equal(editor.scopeSelectedProfiles[0].name, 'P1');
  assert.equal(editor.scopeSelectedProfiles[0].missing, true);
  assert.equal(editor.isScopeSelected('ssh:replacement'), false);
  editor.saveMetric(true);
  const scope = config.store.plugin.serverStats.customMetrics[0].displayScope;
  assert.equal(scope.mode, 'selected');
  assert.equal(scope.profileIds.join(','), 'ssh:p1');
  assert.equal(scope.profileNames['ssh:p1'], 'P1');
});

test('scope: rename follows stable ID and searching is independent of saved selection', () => {
  const { config, editor } = scopeFixture();
  editor.editMetric(0);
  editor.toggleScopeProfile('ssh:p2', true);
  editor.saveMetric(true);
  config.store.profiles[1].name = 'Production';
  editor.editMetric(0);
  assert.equal(editor.scopeSelectedProfiles[0].name, 'Production');
  editor.scopeSearch = 'PROD';
  assert.equal(editor.scopeChoices.length, 1);
  assert.equal(editor.scopeChoices[0].id, 'ssh:p2');
  editor.scopeSearch = 'nothing';
  assert.equal(editor.scopeChoices.length, 0);
  assert.equal(editor.scopeSelectedProfiles.length, 1);
  editor.saveMetric(true);
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope.profileNames['ssh:p2'], 'Production');
});

test('scope: folder labels resolve by group ID and ambiguous names retain distinct IDs', () => {
  const { config, editor } = scopeFixture();
  config.store.groups = [{ id: 'folder:uuid', name: 'P4 Servers' }];
  config.store.profiles = [
    { id: 'ssh:a:11111111', name: 'Server', group: 'folder:uuid', type: 'ssh' },
    { id: 'ssh:b:22222222', name: 'Server', group: 'folder:uuid', type: 'ssh' },
    { id: 'ssh:c', name: 'Other', group: 'Legacy folder', type: 'ssh' },
  ];
  editor.scopeSearch = 'P4';
  assert.equal(editor.scopeChoices.length, 2);
  assert.equal(editor.scopeChoices[0].group, 'P4 Servers');
  assert.equal(editor.scopeChoices[0].disambiguator, '11111111');
  assert.equal(editor.scopeChoices[1].disambiguator, '22222222');
  editor.toggleScopeProfile('ssh:b:22222222', true);
  assert.equal(editor.isScopeSelected('ssh:a:11111111'), false);
  assert.equal(editor.isScopeSelected('ssh:b:22222222'), true);
});

test('group copies have independent IDs, nested rules and scopes, without preset identity', () => {
  const { config, editor } = scopeFixture();
  const conf = config.store.plugin.serverStats;
  const member = { id: 'm', label: '/', command: 'printf 1234', type: 'text', colorRules: [{ operator: '<', value: '20', color: '#ff0000' }] };
  const original = { id: 'g', label: 'Disks', mode: 'carousel', layout: 'vertical', main: member,
    children: [{ ...member, id: 'c', label: '/data' }], displayScope: { mode: 'selected', profileIds: ['ssh:test'] },
    presetOrigin: { kind: 'group', id: 'disk', source: 'https://github.com/example/presets' } };
  conf.metricGroups = [original];
  editor.copyGroup(0);
  const copy = conf.metricGroups[1];
  assert.equal(conf.metricGroups.length, 2);
  assert.equal(copy.label, 'Disks (Copy)');
  assert.notEqual(copy.id, original.id);
  assert.notEqual(copy.main.id, original.main.id);
  assert.notEqual(copy.children[0].id, original.children[0].id);
  assert.equal(copy.presetOrigin, undefined);
  assert.equal(editor.expandedMemberId, null);
  copy.main.colorRules[0].value = '99';
  copy.displayScope.profileIds.push('ssh:other');
  assert.equal(original.main.colorRules[0].value, '20');
  assert.equal(original.displayScope.profileIds.length, 1);
  editor.copyGroup(0);
  assert.equal(conf.metricGroups[1].label, 'Disks (Copy) 2');
});

test('child duplication is an isolated draft until saving its group', () => {
  const { config, editor } = scopeFixture();
  editor.newGroup();
  Object.assign(editor.currentGroup, { label: 'Disks' });
  Object.assign(editor.currentGroup.main, { label: 'Total', command: 'printf 1' });
  editor.addChild();
  Object.assign(editor.currentMetric, { label: '/data', command: 'printf 2', checkCommand: 'mountpoint -q /data', detailCommand: 'printf 2/3', colorRules: [{ operator: '<', value: '20', color: '#ff0000' }] });
  editor.saveGroup(true);
  editor.editGroup(0);
  editor.copyChild(0);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].children.length, 1);
  assert.equal(editor.currentGroup.children.length, 2);
  assert.equal(editor.currentMetric.label, '/data (Copy)');
  assert.notEqual(editor.currentMetric.id, editor.currentGroup.children[0].id);
  editor.currentMetric.colorRules[0].value = '40';
  assert.equal(editor.currentGroup.children[0].colorRules[0].value, '20');
  editor.saveGroup(true);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].children.length, 2);
});

test('tutorial passes the selected locale to the native PDF opener', async () => {
  const { config } = scopeFixture();
  const locales = [];
  mocks['../tutorial'].openTutorialPdf = async locale => locales.push(locale);
  const editor = new exportsObject.ServerStatsSettingsComponent({}, config, {});
  config.store.language = 'zh-CN'; await editor.openTutorial();
  config.store.language = 'en'; await editor.openTutorial();
  assert.equal(locales.join('|'), 'zh-CN|en');
});

test('tutorial failures are localized and a retry clears the message', async () => {
  const { config, editor } = scopeFixture();
  config.store.language = 'zh-CN';
  mocks['../tutorial'].openTutorialPdf = async () => { throw { code: 'missing' }; };
  await editor.openTutorial();
  assert.equal(editor.tutorialError, '未找到教程 PDF，请重新安装插件后再试。');
  assert.equal(editor.tutorialOpening, false);
  mocks['../tutorial'].openTutorialPdf = async () => { throw { code: 'openFailed' }; };
  config.store.language = 'en';
  await editor.openTutorial();
  assert.equal(editor.tutorialError, 'Could not open the tutorial PDF. Check your default PDF reader and try again.');
  mocks['../tutorial'].openTutorialPdf = async () => {};
  await editor.openTutorial();
  assert.equal(editor.tutorialError, '');
  assert.equal(editor.tutorialOpening, false);
});

test('tutorial prevents repeated clicks until the system opener completes', async () => {
  const { editor } = scopeFixture();
  let finish, calls = 0;
  mocks['../tutorial'].openTutorialPdf = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const pending = editor.openTutorial();
  assert.equal(editor.tutorialOpening, true);
  await editor.openTutorial();
  assert.equal(calls, 1);
  finish(); await pending;
  assert.equal(editor.tutorialOpening, false);
  mocks['../tutorial'].openTutorialPdf = async () => {};
});

(async () => {
  const compilerPath = require.resolve('@angular/compiler', { paths: [repo] });
  const compiler = await import(pathToFileURL(compilerPath));
  const parsed = compiler.parseTemplate(componentMetadata.template, 'settings.component.ts');
  assert.equal(parsed.errors, null, JSON.stringify(parsed.errors));
  assert.equal(componentMetadata.selector, 'server-stats-settings');
  console.log('PASS: Angular template parsing, legacy compatibility, group draft/save/cancel, per-child defaults, stable IDs, reordering, validation');
})().catch(error => { console.error(error); process.exitCode = 1; });
