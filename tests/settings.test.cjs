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
    Injectable: noopDecorator, HostListener: noopDecorator,
  },
  '@angular/platform-browser': {},
  'tabby-core': {},
  'tabby-settings': { SettingsTabProvider: class {} },
  '../config': { POPULAR_ICON_PRESETS: [] },
  '../builtin-metrics': loadPureSource('src/builtin-metrics.ts'),
  '../preset-library': loadPureSource('src/preset-library.ts'),
  '../preset-github': loadPureSource('src/preset-github.ts'),
  '../metric-colors': loadPureSource('src/metric-colors.ts'),
  '../translations': loadPureSource('src/translations.ts'),
};
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  experimentalDecorators: true,
}}).outputText;
vm.runInNewContext(compiled, {
  require: name => { if (!(name in mocks)) throw Error('Unexpected module ' + name); return mocks[name]; },
  exports: exportsObject, console, confirm: () => true, setTimeout,
});
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
s.saveGroup();
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
s.saveMetric();
assert.equal(config.store.plugin.serverStats.metricGroups[0].children[0].id, child1Id);

// Reordering singles while editing never updates the wrong metric.
config.store.plugin.serverStats.customMetrics.push({ id: 'other', label: 'Other', command: 'printf other', type: 'text' });
s.editMetric(0);
s.currentMetric.label = 'Updated old';
s.onDragStart(0);
s.onDrop(1);
s.saveMetric();
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
  editor.saveMetric();
  assert.equal(config.store.plugin.serverStats.customMetrics[0].checkMode, 'exitCode');
  Object.assign(config.store.plugin.serverStats.customMetrics[0], { checkMode: 'output', checkExpected: 'exists' });
  editor.editMetric(0);
  assert.equal(editor.currentMetric.checkMode, 'output');
  assert.equal(editor.currentMetric.checkExpected, 'exists');
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
  editor.toggleGroupMetric(-1);
  assert.equal(editor.expandedMemberId, mainId);
  assert.equal(editor.currentMetric.command, 'printf main');
  editor.toggleGroupMetric(0);
  assert.equal(editor.expandedMemberId, childId);
  assert.equal(editor.currentMetric.detailCommand, 'printf details');
  assert.equal(editor.isScopeSelected('ssh:p1'), true);
  editor.saveGroup();
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

test('explicit group edit retains the current draft and Cancel closes it without saving', () => {
  const { config, editor } = scopeFixture();
  editor.newGroup();
  Object.assign(editor.currentMetric, { label: 'Main', command: 'printf main' });
  editor.currentGroup.label = 'Stored';
  editor.saveGroup();
  editor.editGroup(0);
  editor.currentGroup.label = 'Draft';
  editor.currentMetric.command = 'printf edited';
  editor.editGroup(0);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].label, 'Stored');
  assert.equal(editor.currentGroup.label, 'Draft');
  assert.equal(editor.currentMetric.command, 'printf edited');
  editor.cancelEdit();
  assert.equal(editor.currentGroup, null);
  assert.equal(editor.editingGroupId, null);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].label, 'Stored');
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
  editor.saveMetric();
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
  editor.saveGroup();
  editor.toggleGroupEnabled(0);
  const group = config.store.plugin.serverStats.metricGroups[0];
  assert.equal(group.enabled, false);
  assert.equal(group.children[0].command, 'printf 2');
  editor.editGroup(0);
  editor.toggleMemberEnabled(editor.currentGroup.children[0]);
  assert.notEqual(group.children[0].enabled, false);
  editor.saveGroup();
  assert.equal(config.store.plugin.serverStats.metricGroups[0].children[0].enabled, false);
  assert.equal(config.store.plugin.serverStats.metricGroups[0].enabled, false);
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
  conf.defaultMetrics = { cpu: false, ram: true, disk: true, net: true };
  editor.editBuiltin('cpu');
  const original = editor.currentMetric.command;
  editor.currentMetric.command = 'printf 7';
  assert.equal(conf.defaultMetricOverrides, undefined);
  editor.cancelEdit();
  editor.editBuiltin('cpu');
  assert.equal(editor.currentMetric.command, original);
  editor.currentMetric.command = 'printf 8';
  editor.saveMetric();
  assert.equal(conf.defaultMetricOverrides.cpu.command, 'printf 8');
  assert.equal(conf.defaultMetrics.cpu, false);
  assert.equal(conf.customMetrics.length, 1);
  editor.editBuiltin('disk');
  editor.currentMetric.command = 'printf 9';
  editor.saveMetric();
  editor.restoreBuiltin('cpu');
  assert.equal(conf.defaultMetricOverrides.cpu, undefined);
  assert.equal(conf.defaultMetricOverrides.disk.command, 'printf 9');
  assert.equal(conf.defaultMetrics.cpu, false);
  assert.equal(conf.customMetrics[0].id, 'legacy');
});

test('built-in network group saves overrides independently of custom groups', () => {
  const { config, editor } = scopeFixture();
  editor.editBuiltin('net');
  assert.equal(editor.currentGroup.id, 'builtin-net');
  editor.selectGroupMetric(0);
  editor.currentMetric.command = 'printf 12';
  editor.currentMetric.color = '#ff1122';
  editor.saveGroup();
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
  assert.equal(editor.builtinKeys.join(','), 'net,cpu,ram,disk');
  assert.equal(conf.builtinOrder.join(','), 'net,cpu,ram,disk');
  assert.equal(JSON.stringify({ flags: conf.defaultMetrics, overrides: conf.defaultMetricOverrides }), unchanged);
  editor.moveBuiltin('net', -1);
  assert.equal(conf.builtinOrder.join(','), 'net,cpu,ram,disk');
  const reopened = new exportsObject.ServerStatsSettingsComponent({}, config, {});
  assert.equal(reopened.builtinKeys.join(','), 'net,cpu,ram,disk');
  editor.restoreBuiltin('ram');
  assert.equal(conf.builtinOrder.join(','), 'net,cpu,ram,disk');
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

test('preset library import only previews; additions regenerate IDs and preserve restricted missing targets', () => {
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
  assert.equal(new Set(ids).size, 6);
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
  editor.loadPresetLibrary(empty);
  editor.addPreset(editor.presets[0]);
  assert.equal(config.store.plugin.serverStats.customMetrics[1].displayScope.mode, 'selected');
  assert.equal(config.store.plugin.serverStats.customMetrics[1].displayScope.profileIds.length, 0);
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
  editor.saveGroup();
  const exported = JSON.parse(editor.currentPresetLibrary()).find(entry => entry.kind === 'group');
  assert.deepEqual(exported.labels, preset.labels);
  assert.deepEqual(exported.descriptions, preset.descriptions);
  assert.deepEqual(exported.source, preset.source);
  assert.equal(exported.group.presetMetadata, undefined);
  assert.equal(exported.group.main.command, 'printf 20');
  assert.equal(exported.group.displayScope.mode, 'selected');
  config.store.language = 'zh-CN';
  editor.addPreset(exported);
  assert.equal(editor.metricGroups[1].label, 'GPU 显存');
  editor.editGroup(1);
  editor.currentGroup.label = 'My custom GPU';
  editor.saveGroup();
  const renamed = JSON.parse(editor.currentPresetLibrary()).find(entry => entry.label === 'My custom GPU');
  assert.equal(renamed.labels, undefined);
  editor.addPreset(renamed);
  assert.equal(editor.metricGroups[2].label, 'My custom GPU');
  assert.equal(editor.metricGroups[2].displayScope.profileIds.length, 0);
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
  editor.saveMetric();
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
  editor.saveGroup();
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
  editor.saveMetric();
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope.mode, 'selected');
  assert.equal(config.store.plugin.serverStats.customMetrics[0].displayScope.profileIds.length, 0);
  editor.editMetric(0);
  assert.equal(editor.scopeMode, 'selected');
});

test('scope: deleted target names are retained and a new same-name ID never becomes selected', () => {
  const { config, editor } = scopeFixture();
  editor.editMetric(0);
  editor.toggleScopeProfile('ssh:p1', true);
  editor.saveMetric();
  config.store.profiles = [{ id: 'ssh:replacement', name: 'P1', type: 'ssh' }];
  editor.editMetric(0);
  assert.equal(editor.hasMissingScopeProfiles, true);
  assert.equal(editor.scopeSelectedProfiles[0].id, 'ssh:p1');
  assert.equal(editor.scopeSelectedProfiles[0].name, 'P1');
  assert.equal(editor.scopeSelectedProfiles[0].missing, true);
  assert.equal(editor.isScopeSelected('ssh:replacement'), false);
  editor.saveMetric();
  const scope = config.store.plugin.serverStats.customMetrics[0].displayScope;
  assert.equal(scope.mode, 'selected');
  assert.equal(scope.profileIds.join(','), 'ssh:p1');
  assert.equal(scope.profileNames['ssh:p1'], 'P1');
});

test('scope: rename follows stable ID and searching is independent of saved selection', () => {
  const { config, editor } = scopeFixture();
  editor.editMetric(0);
  editor.toggleScopeProfile('ssh:p2', true);
  editor.saveMetric();
  config.store.profiles[1].name = 'Production';
  editor.editMetric(0);
  assert.equal(editor.scopeSelectedProfiles[0].name, 'Production');
  editor.scopeSearch = 'PROD';
  assert.equal(editor.scopeChoices.length, 1);
  assert.equal(editor.scopeChoices[0].id, 'ssh:p2');
  editor.scopeSearch = 'nothing';
  assert.equal(editor.scopeChoices.length, 0);
  assert.equal(editor.scopeSelectedProfiles.length, 1);
  editor.saveMetric();
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

(async () => {
  const compilerPath = require.resolve('@angular/compiler', { paths: [repo] });
  const compiler = await import(pathToFileURL(compilerPath));
  const parsed = compiler.parseTemplate(componentMetadata.template, 'settings.component.ts');
  assert.equal(parsed.errors, null, JSON.stringify(parsed.errors));
  assert.equal(componentMetadata.selector, 'server-stats-settings');
  console.log('PASS: Angular template parsing, legacy compatibility, group draft/save/cancel, per-child defaults, stable IDs, reordering, validation');
})().catch(error => { console.error(error); process.exitCode = 1; });
