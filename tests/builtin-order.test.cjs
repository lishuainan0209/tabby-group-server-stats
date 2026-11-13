const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename)
const builtins = require('../src/builtin-metrics.ts')
const display = require('../src/metric-display.ts')
const model = require('../src/metric-model.ts')
const { normalizeBuiltinOrder, orderBuiltinItems, getBuiltinDefinitions, getBuiltinDefaults, migrateLegacyBuiltinConfig } = builtins
const metadata = new Map()
function loadView(name) {
    const exports = {}
    const decorator = () => () => {}
    const source = fs.readFileSync(path.join(__dirname, '../src/components', name + '.component.ts'), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true,
    } }).outputText
    vm.runInNewContext(compiled, { exports, window: {}, console, require: name => {
        if (name === '@angular/core') return {
            Component: info => { metadata.set(info.selector, info); return () => {} },
            Input: decorator, HostListener: decorator, ViewChild: decorator, ViewChildren: decorator,
        }
        if (name === '../builtin-metrics') return builtins
        if (name === '../metric-display') return display
        if (name === '../config') return model
        return {}
    } })
    return exports
}
const { ServerStatsBottomBarComponent: Bottom } = loadView('bottom-bar')
const { ServerStatsFloatingPanelComponent: Floating } = loadView('floating-panel')
const { MetricStripComponent: Strip } = loadView('metric-strip')
const ids = items => Array.from(items, item => item.id)

test('built-in order removes invalid and duplicate entries and appends missing keys without mutation', () => {
    assert.deepEqual(normalizeBuiltinOrder(), ['ram', 'net', 'load'])
    assert.deepEqual(normalizeBuiltinOrder('net'), ['ram', 'net', 'load'])
    const saved = ['net', 'cpu', 'net', 'unknown', null, 1, 'disk', 'load']
    const original = saved.slice()
    assert.deepEqual(normalizeBuiltinOrder(saved), ['net', 'load', 'ram'])
    assert.deepEqual(saved, original)
    assert.deepEqual(normalizeBuiltinOrder(['ram']), ['ram', 'net', 'load'])
})

test('the network group can occupy every built-in position before custom items', () => {
    const defs = getBuiltinDefinitions()
    const metrics = [...defs.customMetrics, { id: 'custom-a' }, { id: 'custom-b' }]
    const groups = [...defs.metricGroups, { id: 'custom-group' }]
    const before = ids(metrics)
    for (let position = 0; position < 3; position++) {
        const order = ['load', 'ram']
        order.splice(position, 0, 'net')
        const items = orderBuiltinItems(metrics, groups, order)
        assert.deepEqual(ids(items), [...order.map(key => 'builtin-' + key), 'custom-a', 'custom-b', 'custom-group'])
        assert.equal(items[position].group.id, 'builtin-net')
    }
    assert.deepEqual(ids(metrics), before)
})

test('disabled slots retain saved order but supply no collection command or rendered item', () => {
    const conf = {
        builtinOrder: ['net', 'ram', 'load'],
        defaultMetrics: { ram: true, load: false, net: false },
        defaultMetricOverrides: { ram: { ...getBuiltinDefaults().ram, command: 'printf 42' } },
    }
    let defs = getBuiltinDefinitions(conf)
    assert.deepEqual(ids(model.allMetrics(defs)), ['builtin-ram'])
    const strip = new Strip({}, {}, {}, {})
    Object.assign(strip, { metrics: defs.customMetrics, groups: defs.metricGroups, builtinOrder: conf.builtinOrder })
    assert.deepEqual(ids(strip.visibleItems), ['builtin-ram'])
    const restored = JSON.parse(JSON.stringify(conf))
    delete restored.defaultMetricOverrides.ram
    restored.defaultMetrics.net = true
    restored.defaultMetrics.load = true
    defs = getBuiltinDefinitions(restored)
    assert.deepEqual(ids(orderBuiltinItems(defs.customMetrics, defs.metricGroups, restored.builtinOrder)), ['builtin-net', 'builtin-ram', 'builtin-load'])
    assert.deepEqual(restored.builtinOrder, conf.builtinOrder)
    assert.notEqual(defs.customMetrics.find(metric => metric.id === 'builtin-ram').command, 'printf 42')
})

test('bottom and floating panels pass persisted order to the same mixed strip renderer', () => {
    const saved = JSON.parse(JSON.stringify({ builtinOrder: ['load', 'net', 'ram'] }))
    const config = { store: { plugin: { serverStats: saved } } }
    const service = { getVisibleConfig: () => getBuiltinDefinitions(saved) }
    for (const Component of [Bottom, Floating]) {
        const panel = new Component(service, config, {}, {}, {}, {})
        panel.applyMetricScope({})
        const strip = new Strip({}, {}, {}, {})
        Object.assign(strip, { metrics: panel.customMetrics, groups: panel.metricGroups, builtinOrder: panel.builtinOrder })
        assert.deepEqual(ids(strip.visibleItems), ['builtin-load', 'builtin-net', 'builtin-ram'])
        saved.builtinOrder = ['ram', 'load', 'net']
        panel.applyMetricScope({})
        strip.builtinOrder = panel.builtinOrder
        assert.deepEqual(ids(strip.visibleItems), ['builtin-ram', 'builtin-load', 'builtin-net'])
        saved.builtinOrder = ['load', 'net', 'ram']
    }
})

test('fresh defaults collect only memory, network and CPU load', () => {
    const conf = {}
    assert.equal(migrateLegacyBuiltinConfig(conf), true)
    const defs = getBuiltinDefinitions(conf)
    assert.deepEqual(ids(orderBuiltinItems(defs.customMetrics, defs.metricGroups)), ['builtin-ram', 'builtin-net', 'builtin-load'])
    assert.deepEqual(conf.customMetrics, [])
    const load = defs.metricGroups.find(group => group.id === 'builtin-load')
    assert.equal(load.main.label, 'Threads')
    assert.deepEqual(load.children.map(metric => metric.label), ['1min', '5min'])
    assert(load.children.every(metric => metric.type === 'text' && metric.colorRules[0].value === '150' && metric.colorRules[1].value === '100'))
    assert.equal(migrateLegacyBuiltinConfig(conf), false)
})

test('network overview displays the collected combined main before and after its first result', () => {
    const definitions = getBuiltinDefinitions()
    const network = definitions.metricGroups.find(group => group.id === 'builtin-net')
    network.mode = 'overview'
    const collected = model.allMetrics(definitions)
    assert(collected.some(metric => metric.id === network.main.id), 'The overview must have a collection command')
    assert.equal(network.main.command, builtins.createNetworkRateCommand('total'))
    const strip = new Strip({}, {}, {}, {})
    Object.assign(strip, { groups: [network], metrics: [], stats: { custom: [] } })
    assert.equal(strip.collapsedMetric(network).id, 'builtin-net-main', 'Pending total keeps its placeholder')
    strip.stats = { custom: [{ id: 'builtin-net-main', value: '6.40', status: 'ok' }] }
    assert.equal(strip.collapsedMetric(network).id, 'builtin-net-main')
    assert.deepEqual(ids(strip.visibleGroups), ['builtin-net'])
})

test('network migration enables an untouched legacy total once and preserves group and child edits', () => {
    const network = getBuiltinDefaults().net
    network.main.enabled = false
    network.mode = 'overview'
    network.label = 'My network'
    network.children[0].label = 'Incoming'
    network.children[0].command = 'printf 42'
    const conf = { builtinDefaultsVersion: 1, defaultMetricOverrides: { net: network } }
    const children = JSON.stringify(network.children)
    assert.equal(migrateLegacyBuiltinConfig(conf), true)
    assert.equal(conf.builtinDefaultsVersion, 2)
    assert.equal(network.main.enabled, true)
    assert.equal(network.mode, 'overview')
    assert.equal(network.label, 'My network')
    assert.equal(JSON.stringify(network.children), children)
    network.main.enabled = false
    const saved = JSON.stringify(conf)
    assert.equal(migrateLegacyBuiltinConfig(conf), false)
    assert.equal(JSON.stringify(conf), saved, 'A later deliberate disable must survive startup')
})

test('network migration preserves customized main commands, appearance, scope and explicit group disabling', () => {
    for (const edit of [{ command: 'printf 42' }, { color: '#123456' }, { label: 'VPN' },
        { displayScope: { mode: 'selected', profileIds: ['vpn'] } }, { detailCommand: 'printf custom' }]) {
        const network = getBuiltinDefaults().net
        Object.assign(network.main, { enabled: false }, edit)
        const conf = { builtinDefaultsVersion: 1, defaultMetricOverrides: { net: network } }
        const saved = JSON.stringify(network)
        assert.equal(migrateLegacyBuiltinConfig(conf), true)
        assert.equal(JSON.stringify(network), saved)
    }
    const conf = { builtinDefaultsVersion: 1, defaultMetrics: { net: false },
        defaultMetricOverrides: { net: { ...getBuiltinDefaults().net, enabled: false } } }
    migrateLegacyBuiltinConfig(conf)
    assert.equal(conf.defaultMetrics.net, false)
    assert.equal(conf.defaultMetricOverrides.net.enabled, false)
    assert.equal(model.allMetrics(getBuiltinDefinitions(conf)).length, 0)
})

test('legacy enabled and edited built-ins survive as independent custom labels exactly once', () => {
    const existing = { id: 'legacy-builtin-cpu', label: 'Kept', command: 'printf kept', type: 'text' }
    const disk = { ...getBuiltinDefaults().disk, label: 'Archive', command: 'printf 91',
        displayScope: { mode: 'selected', profileIds: ['connection-a'] } }
    const conf = { defaultMetrics: { cpu: true, disk: false, ram: false, net: true },
        defaultMetricOverrides: { disk }, customMetrics: [existing], builtinOrder: ['net', 'disk', 'ram', 'cpu'] }
    assert.equal(migrateLegacyBuiltinConfig(conf), true)
    assert.deepEqual(conf.builtinOrder, ['net', 'ram', 'load'])
    assert.deepEqual(conf.customMetrics[0], existing)
    assert.equal(conf.customMetrics[1].id, 'legacy-builtin-cpu-2')
    assert.equal(conf.customMetrics[1].enabled, true)
    assert.equal(conf.customMetrics[2].enabled, false)
    assert.equal(conf.customMetrics[2].command, 'printf 91')
    assert.deepEqual(conf.customMetrics[2].displayScope, disk.displayScope)
    assert.equal(conf.defaultMetrics.cpu, false)
    assert.equal(conf.defaultMetrics.disk, false)
    assert.equal(conf.defaultMetrics.ram, false)
    const saved = JSON.stringify(conf)
    assert.equal(migrateLegacyBuiltinConfig(conf), false)
    assert.equal(JSON.stringify(conf), saved)
})

test('existing CPU load groups prevent duplicate defaults without changing bindings or edits', () => {
    const presets = JSON.parse(fs.readFileSync(path.join(__dirname, '../presets.json'), 'utf8'))
    const preset = presets.find(entry => entry.id === 'cpu-load-group')
    for (const tagged of [false, true]) {
        const group = JSON.parse(JSON.stringify(preset.group))
        group.id = 'user-load'; group.enabled = false
        group.displayScope = { mode: 'selected', profileIds: ['saved-pane'] }
        if (tagged) {
            group.presetOrigin = { id: preset.id, kind: 'group', source: preset.source.url }
            group.main.command = 'printf edited'
        }
        const before = JSON.stringify(group)
        const conf = { metricGroups: [group] }
        migrateLegacyBuiltinConfig(conf)
        assert.equal(conf.defaultMetrics.load, false)
        assert.equal(JSON.stringify(conf.metricGroups[0]), before)
    }
    const unrelated = JSON.parse(JSON.stringify(preset.group))
    unrelated.main.command = 'printf custom'
    const conf = { metricGroups: [unrelated] }
    migrateLegacyBuiltinConfig(conf)
    assert.equal(conf.defaultMetrics.load, true, 'same display name alone must not suppress the default')
})

test('mixed strip and both parent templates parse successfully', async () => {
    const compiler = await import(pathToFileURL(require.resolve('@angular/compiler')))
    for (const [selector, component] of metadata) {
        const parsed = compiler.parseTemplate(component.template, selector)
        assert.equal(parsed.errors, null, JSON.stringify(parsed.errors))
    }
})
