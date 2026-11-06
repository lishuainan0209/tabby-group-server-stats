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
const { normalizeBuiltinOrder, orderBuiltinItems, getBuiltinDefinitions, getBuiltinDefaults } = builtins
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
    assert.deepEqual(normalizeBuiltinOrder(), ['cpu', 'ram', 'disk', 'net'])
    assert.deepEqual(normalizeBuiltinOrder('net'), ['cpu', 'ram', 'disk', 'net'])
    const saved = ['net', 'cpu', 'net', 'unknown', null, 1, 'disk']
    const original = saved.slice()
    assert.deepEqual(normalizeBuiltinOrder(saved), ['net', 'cpu', 'disk', 'ram'])
    assert.deepEqual(saved, original)
    assert.deepEqual(normalizeBuiltinOrder(['ram']), ['ram', 'cpu', 'disk', 'net'])
})

test('the network group can occupy every built-in position before custom items', () => {
    const defs = getBuiltinDefinitions()
    const metrics = [...defs.customMetrics, { id: 'custom-a' }, { id: 'custom-b' }]
    const groups = [...defs.metricGroups, { id: 'custom-group' }]
    const before = ids(metrics)
    for (let position = 0; position < 4; position++) {
        const order = ['disk', 'cpu', 'ram']
        order.splice(position, 0, 'net')
        const items = orderBuiltinItems(metrics, groups, order)
        assert.deepEqual(ids(items), [...order.map(key => 'builtin-' + key), 'custom-a', 'custom-b', 'custom-group'])
        assert.equal(items[position].group.id, 'builtin-net')
    }
    assert.deepEqual(ids(metrics), before)
})

test('disabled slots retain saved order but supply no collection command or rendered item', () => {
    const conf = {
        builtinOrder: ['net', 'ram', 'cpu', 'disk'],
        defaultMetrics: { cpu: true, ram: false, disk: true, net: false },
        defaultMetricOverrides: { cpu: { ...getBuiltinDefaults().cpu, command: 'printf 42' } },
    }
    let defs = getBuiltinDefinitions(conf)
    assert.deepEqual(ids(model.allMetrics(defs)), ['builtin-cpu', 'builtin-disk'])
    const strip = new Strip({}, {}, {}, {})
    Object.assign(strip, { metrics: defs.customMetrics, groups: defs.metricGroups, builtinOrder: conf.builtinOrder })
    assert.deepEqual(ids(strip.visibleItems), ['builtin-cpu', 'builtin-disk'])
    const restored = JSON.parse(JSON.stringify(conf))
    delete restored.defaultMetricOverrides.cpu
    restored.defaultMetrics.net = true
    restored.defaultMetrics.ram = true
    defs = getBuiltinDefinitions(restored)
    assert.deepEqual(ids(orderBuiltinItems(defs.customMetrics, defs.metricGroups, restored.builtinOrder)), ['builtin-net', 'builtin-ram', 'builtin-cpu', 'builtin-disk'])
    assert.deepEqual(restored.builtinOrder, conf.builtinOrder)
    assert.notEqual(defs.customMetrics.find(metric => metric.id === 'builtin-cpu').command, 'printf 42')
})

test('bottom and floating panels pass persisted order to the same mixed strip renderer', () => {
    const saved = JSON.parse(JSON.stringify({ builtinOrder: ['disk', 'net', 'ram', 'cpu'] }))
    const config = { store: { plugin: { serverStats: saved } } }
    const service = { getVisibleConfig: () => getBuiltinDefinitions(saved) }
    for (const Component of [Bottom, Floating]) {
        const panel = new Component(service, config, {}, {}, {}, {})
        panel.applyMetricScope({})
        const strip = new Strip({}, {}, {}, {})
        Object.assign(strip, { metrics: panel.customMetrics, groups: panel.metricGroups, builtinOrder: panel.builtinOrder })
        assert.deepEqual(ids(strip.visibleItems), ['builtin-disk', 'builtin-net', 'builtin-ram', 'builtin-cpu'])
        saved.builtinOrder = ['cpu', 'ram', 'net', 'disk']
        panel.applyMetricScope({})
        strip.builtinOrder = panel.builtinOrder
        assert.deepEqual(ids(strip.visibleItems), ['builtin-cpu', 'builtin-ram', 'builtin-net', 'builtin-disk'])
        saved.builtinOrder = ['disk', 'net', 'ram', 'cpu']
    }
})

test('mixed strip and both parent templates parse successfully', async () => {
    const compiler = await import(pathToFileURL(require.resolve('@angular/compiler')))
    for (const [selector, component] of metadata) {
        const parsed = compiler.parseTemplate(component.template, selector)
        assert.equal(parsed.errors, null, JSON.stringify(parsed.errors))
    }
})
