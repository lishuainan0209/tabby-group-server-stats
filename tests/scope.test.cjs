const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const api = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../src/display-scope.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, { exports: api, Set })
const profiles = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'layout', type: 'split-layout' }]
const selected = (...profileIds) => ({ mode: 'selected', profileIds })
test('legacy and explicit global scopes include unsaved sessions', () => {
    assert(api.matchesScope(undefined, { profileIds: [] }, []))
    assert(api.matchesScope({ mode: 'all', profileIds: ['deleted'] }, { profileIds: [] }, []))
})
test('selected empty, deleted and corrupt scopes never become global', () => {
    assert(!api.matchesScope(selected(), { profileIds: ['p1'] }, profiles))
    assert(!api.matchesScope(selected('deleted'), { profileIds: ['deleted'] }, profiles))
    assert(!api.matchesScope({ mode: 'invalid', profileIds: [] }, { profileIds: ['p1'] }, profiles))
})
test('selection is a union of stable IDs, independent of renamed or duplicate names', () => {
    assert(api.matchesScope(selected('p1', 'p2'), { profileIds: ['p2'] }, profiles))
    assert(api.matchesScope(selected('p1'), { profileIds: ['p1'] }, [{ id: 'p1', name: 'Renamed' }]))
    assert(!api.matchesScope(selected('p1'), { profileIds: ['new-p1'] }, [{ id: 'new-p1', name: 'P1' }]))
})
test('mixed-layout leaf scopes do not match sibling profiles, while layout-wide scopes inherit', () => {
    const left = { profileIds: ['p1', 'layout'] }, center = { profileIds: ['p2', 'layout'] }
    assert(api.matchesScope(selected('p1'), left, profiles))
    assert(!api.matchesScope(selected('p1'), center, profiles))
    assert(api.matchesScope(selected('layout'), left, profiles))
    assert(api.matchesScope(selected('layout'), center, profiles))
})
test('whole group inherits its own scope regardless of nested stale child scope', () => {
    const group = { id: 'g', displayScope: selected('p1'), main: { id: 'main' }, children: [{ id: 'child', displayScope: selected('p2') }] }
    assert.equal(api.filterScopedMetrics({ metricGroups: [group] }, { profileIds: ['p1'] }, profiles).metricGroups[0], group)
    assert.equal(api.filterScopedMetrics({ metricGroups: [group] }, { profileIds: ['p2'] }, profiles).metricGroups.length, 0)
})
test('disabled top-level metrics and groups are excluded without mutating their saved definitions', () => {
    const metric = { id: 'disabled', enabled: false, command: 'preserved', colorRules: [{ value: '5' }] }
    const group = { id: 'group', enabled: false, main: { id: 'main' }, children: [] }
    const original = JSON.stringify({ customMetrics: [metric], metricGroups: [group] })
    const result = api.filterScopedMetrics({ customMetrics: [metric, { id: 'legacy' }], metricGroups: [group] }, { profileIds: [] }, [])
    assert.equal(result.customMetrics.map(m => m.id).join(','), 'legacy')
    assert.equal(result.metricGroups.length, 0)
    assert.equal(JSON.stringify({ customMetrics: [metric], metricGroups: [group] }), original)
})
test('findSessionTab uses actual leaf session identity even with nested wrappers and changed focus', () => {
    const a = {}, b = {}, c = {}
    const leaves = [{ session: a, profile: profiles[0] }, { session: b, profile: profiles[1] }, { session: c, profile: profiles[0] }]
    const split = { getAllTabs: () => leaves, focusedTab: leaves[1] }
    const outer = { getAllTabs: () => [split] }
    assert.equal(api.findSessionTab([outer], a), leaves[0])
    assert.equal(api.findSessionTab([outer], c), leaves[2])
    split.focusedTab = leaves[0]
    assert.equal(api.findSessionTab([outer], b), leaves[1])
    assert.equal(api.findSessionTab([outer], {}), null)
})
