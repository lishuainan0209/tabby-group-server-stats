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

const savedLayout = (id, children) => ({ id, name: id, type: 'split-layout', options: { recoveryToken: { type: 'app:split-tab', children } } })
const sshToken = (id, name = id) => ({ type: 'app:ssh-tab', profile: { id, type: 'ssh', name, options: { host: 'node.test', port: 22, user: 'test' } } })

test('layout inventory lists each repeated pane separately after the original connection is deleted', () => {
    const saved = [savedLayout('layout', [sshToken('deleted', 'Old SSH'), { type: 'app:split-tab', children: [sshToken('deleted', 'Old SSH')] }])]
    const before = JSON.stringify(saved)
    const targets = api.getLayoutPaneTargets(saved)
    assert.equal(targets.length, 2)
    assert.notEqual(targets[0].id, targets[1].id)
    assert.equal(targets[0].profileId, targets[1].profileId)
    assert.equal(api.layoutPaneTargetName(targets[1]), 'layout / 2.1 / Old SSH')
    assert.equal(targets[0].type, 'layout-pane')
    assert.deepEqual(Object.keys(targets[0]).sort(), ['connectionIds', 'id', 'layoutId', 'layoutName', 'name', 'path', 'profileId', 'type'].sort())
    assert.equal(JSON.stringify(saved), before)
    assert.equal(api.matchesScope(selected(targets[0].id), { profileIds: [targets[0].id, 'deleted', 'layout'] }, saved), true)
    assert.equal(api.matchesScope(selected(targets[0].id), { profileIds: [targets[1].id, 'deleted', 'layout'] }, saved), false)
})

test('excluding one layout pane overrides its connection and parent without excluding matching siblings', () => {
    const saved = [{ id: 'shared', type: 'ssh' }, savedLayout('layout', [sshToken('shared'), sshToken('shared')])]
    const [first, second] = api.getLayoutPaneTargets(saved)
    const scope = { ...selected('shared', 'layout', first.id, second.id), excludedProfileIds: [first.id] }
    assert.equal(api.matchesScope(scope, { profileIds: ['shared', 'layout', first.id] }, saved), false)
    assert.equal(api.matchesScope(scope, { profileIds: ['shared', 'layout', second.id] }, saved), true)
    assert.equal(api.matchesScope(scope, { profileIds: ['shared'] }, saved), true)
    assert.equal(api.matchesScope({ ...scope, mode: 'all' }, { profileIds: [first.id] }, saved), true)
    // Corrupt or old non-pane exclusions must not disable all uses of a connection.
    assert.equal(api.matchesScope({ ...selected('shared'), excludedProfileIds: ['shared'] }, { profileIds: ['shared'] }, saved), true)
})

test('deleting a layout or replacing its child profile invalidates the old pane selection', () => {
    const saved = [savedLayout('layout', [sshToken('old')])]
    const [target] = api.getLayoutPaneTargets(saved)
    const context = { profileIds: [target.id, 'layout', 'old'] }
    assert.equal(api.matchesScope(selected(target.id), context, saved), true)
    saved[0].options.recoveryToken.children[0] = sshToken('replacement')
    assert.equal(api.matchesScope(selected(target.id), context, saved), false)
    assert.equal(api.matchesScope(selected(target.id), context, []), false)
})

test('layout inventory ignores credentials and survives malformed or cyclic recovery trees', () => {
    const node = sshToken('a')
    Object.defineProperty(node.profile.options, 'password', { get() { throw Error('Must not read credentials') } })
    const saved = savedLayout('layout', [node, null, { type: 'app:ssh-tab', profile: { type: 'ssh' } }])
    saved.options.recoveryToken.children.push(saved.options.recoveryToken)
    assert.equal(api.getLayoutPaneTargets([saved]).length, 1)
    assert.equal(api.getLayoutPaneTargets(null).length, 0)
})
