const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(require.resolve('../src/metric-display.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText
const api = {}; vm.runInNewContext(compiled, { exports: api, Set })
const metrics = ['a', 'b', 'c', 'd'].map(id => ({ id, command: 'x', type: 'text' }))
const group = { children: metrics }
const results = metrics.map(m => ({ id: m.id, value: m.id === 'b' || m.id === 'c' ? 'Missing' : '63', status: m.id === 'b' || m.id === 'c' ? 'unavailable' : 'ok' }))

test('network detail separates localizable direction, amount and interface scope', () => {
    const detail = api.parseNetworkDetail('Received total: 201.900 GiB (since interface reset; eth0,enp2s0)')
    assert.equal(detail.label, 'Received total')
    assert.equal(detail.amount, '201.900')
    assert.equal(detail.interfaces, 'eth0,enp2s0')
    assert.equal(api.parseNetworkDetail('Sent total: 0.001 GiB (since interface reset; en0)').label, 'Sent total')
    assert.equal(api.parseNetworkDetail('RX 200 GiB / TX 30 GiB'), null)
    assert.equal(api.parseNetworkDetail('Err: No result'), null)
})
test('failed children remain in carousel by default', () => assert.equal(api.carouselChildren(group, results).map(m => m.id).join(','), 'a,b,c,d'))
test('only opted-out children are skipped, including consecutive failures', () => {
    const g = { children: metrics.map(m => ({ ...m, showWhenUnavailable: false })) }
    assert.equal(api.nextCarouselId(g, results, 'a'), 'd')
    assert.equal(api.nextCarouselId(g, results, 'b'), 'd')
    assert.equal(api.nextCarouselId(g, results, 'd'), 'a')
})
test('one child opt-out does not affect another failed child', () => {
    const g = { children: metrics.map(m => ({ ...m, showWhenUnavailable: m.id !== 'b' })) }
    assert.equal(api.nextCarouselId(g, results, 'a'), 'c')
})
test('all omitted children produce empty selection; a single survivor stays selected', () => {
    const g = { children: metrics.map(m => ({ ...m, showWhenUnavailable: false })) }
    const all = metrics.map(m => ({ id: m.id, value: 'Missing', status: 'unavailable' }))
    assert.equal(api.nextCarouselId(g, all, 'a'), undefined)
    all[2].status = 'ok'
    assert.equal(api.nextCarouselId(g, all, 'c'), 'c')
})
test('errors are not silently treated as absent objects; legacy results still work', () => {
    assert.equal(api.metricStatus({ id: 'a', value: 'Err: Timeout' }), 'error')
    assert.equal(api.metricStatus({ id: 'a', value: '60' }), 'ok')
    assert.equal(api.metricStatus(), 'pending')
})
test('global unavailable visibility affects singles, static rows and popup rows but preserves errors', () => {
    const hidden = { ...metrics[1], visibleWhenUnavailable: false }
    assert.equal(api.metricIsVisible(hidden, results), false)
    assert.equal(api.metricIsVisible({ ...hidden, showWhenUnavailable: true }, results), false)
    assert.equal(api.metricIsVisible(hidden, [{ id: hidden.id, status: 'error', value: 'Err: Timeout' }]), true)
    assert.equal(api.metricIsVisible(hidden, [{ id: hidden.id, status: 'pending', value: '-' }]), true)
    for (const mode of ['overview', 'static', 'carousel']) {
        const value = { main: hidden, children: [metrics[0], hidden, metrics[2]], mode }
        assert.equal(api.visibleGroupMetrics(value, results).map(m => m.id).join(','), 'a,c')
        assert.equal(api.carouselChildren(value, results).map(m => m.id).join(','), 'a,c')
    }
})
test('carousel-only visibility remains independent of popup/static visibility', () => {
    const child = { ...metrics[1], showWhenUnavailable: false }
    const value = { main: metrics[0], children: [child] }
    assert.equal(api.visibleGroupMetrics(value, results).map(m => m.id).join(','), 'a,b')
    assert.equal(api.carouselChildren(value, results).length, 0)
})
test('disabled main, child and group never display or occupy carousel turns', () => {
    const value = { main: { ...metrics[0], enabled: false }, children: [{ ...metrics[1], enabled: false }, metrics[2], metrics[3]] }
    assert.equal(api.visibleGroupMetrics(value, results).map(m => m.id).join(','), 'c,d')
    assert.equal(api.nextCarouselId(value, results, 'd'), 'c')
    value.enabled = false
    assert.equal(api.visibleGroupMetrics(value, results).length, 0)
    assert.equal(api.carouselChildren(value, results).length, 0)
    assert.equal(api.nextCarouselId(value, results, 'c'), undefined)
})
