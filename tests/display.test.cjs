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

test('network display converts KiB/s to decimal MB/s with exactly three decimals', () => {
    for (const [raw, expected] of [
        ['0.819336', '0.001'], ['1.30', '0.001'], ['12345.678', '12.642'],
        ['1234567.89', '1,264.198'], ['1,234.56', '1.264'], ['0', '0.000'],
        ['1e-9', '0.000'], ['1.23456e4', '12.642'], ['-0.001', '0.000'], ['-1234.56', '-1.264'],
        ['1024', '1.049'], ['976.5625', '1.000'],
    ]) {
        assert.equal(api.isNumericDisplayValue(raw), true)
        assert.equal(api.formatNetworkRate(raw), expected)
    }
})

test('network display does not turn missing or nonnumeric command output into zero', () => {
    for (const raw of ['', ' ', '-', 'Err: Timeout', 'NaN', 'Infinity', '1e999', '12,34', '123 KiB/s', 'eth0: 123', '/data']) {
        assert.equal(api.isNumericDisplayValue(raw), false)
        assert.equal(api.formatNetworkRate(raw), raw)
    }
})

test('capacity ratios preserve precision and expose each right-aligned column independently', () => {
    for (const [raw, numerator, denominator, suffix] of [
        ['551.0/8786.0 GiB', '551.0', '8,786.0', 'GB'],
        ['38.3/936.4GB', '38.3', '936.4', 'GB'],
        [' 38.3 / 936.4 GB ', '38.3', '936.4', 'GB'],
        ['1,234.50/12,345.00 MiB', '1,234.50', '12,345.00', 'MiB'],
        ['17/8850', '17', '8850', ''], ['-1.5/+3.0 %', '-1.5', '+3.0', '%'],
        ['0.0/0.0 GiB', '0.0', '0.0', 'GB'],
    ]) {
        const actual = api.parseNumericRatio(raw)
        assert.ok(actual, raw)
        assert.equal(actual.numerator, numerator)
        assert.equal(actual.denominator, denominator)
        assert.equal(actual.suffix, suffix)
    }
})

test('capacity parsing leaves paths, errors and unrelated slash text unchanged', () => {
    for (const raw of ['', '/data', '/12/34', 'Err: 1/2', 'RX 12/TX 34', '12,34/50 GiB', '1/NaN GiB', '1e999/50 GiB', '1/2/3', '1/2 GiB extra', '1/2 users']) {
        assert.equal(api.parseNumericRatio(raw), null, raw)
    }
})

test('capacity grouping preserves decimal precision and existing separators', () => {
    for (const [value, expected] of [['1234', '1,234'], ['12345.00', '12,345.00'], ['1,234.50', '1,234.50'],
        ['-1234567.0', '-1,234,567.0'], ['.5', '.5'], ['Err: 1234', 'Err: 1234'], ['1e4', '1e4']]) {
        assert.equal(api.formatGroupedNumber(value), expected)
    }
})

test('network detail separates localizable direction, amount and interface scope', () => {
    const detail = api.parseNetworkDetail('Received total: 201.900 GiB (since interface reset; eth0,enp2s0)')
    assert.equal(detail.label, 'Received total')
    assert.equal(detail.amount, '201.900')
    assert.equal(detail.interfaces, 'eth0,enp2s0')
    assert.equal(api.parseNetworkDetail('Sent total: 0.001 GiB (since interface reset; en0)').label, 'Sent total')
    assert.equal(api.parseNetworkDetail('Sent total: 0.001 GB (since interface reset; en0)').amount, '0.001')
    assert.equal(api.parseNetworkDetail('RX 200 GiB / TX 30 GiB'), null)
    assert.equal(api.parseNetworkDetail('Err: No result'), null)
})

test('GB presentation accepts old capacity labels without changing numbers or unrelated text', () => {
    for (const [raw, expected] of [
        ['GiB', 'GB'], [' GiB', ' GB'], ['24GiB', '24GB'],
        ['38.3/936.4 GiB available', '38.3/936.4 GB available'],
        ['free 1,234.50 GiB', 'free 1,234.50 GB'], ['24 GB', '24 GB'],
        ['48 MiB', '48 MiB'], ['GiB_count', 'GiB_count'], ['/data/GiB', '/data/GiB'],
    ]) assert.equal(api.formatCapacityUnit(raw), expected)
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
