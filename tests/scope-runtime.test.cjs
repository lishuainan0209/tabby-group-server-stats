const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')
const { Subject } = require('rxjs')

require.extensions['.ts'] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017, experimentalDecorators: true,
    } }).outputText
    module._compile(output, filename)
}
const originalLoad = Module._load
Module._load = function (name, parent, isMain) {
    if (name === '@angular/core') return { Injectable: () => type => type }
    if (name === 'tabby-core') return {}
    return originalLoad.call(this, name, parent, isMain)
}
const { MetricScopeService, LAYOUT_SCOPE_MARKER: marker } = require('../src/services/metric-scope.service.ts')
const { matchesScope } = require('../src/display-scope.ts')

const token = (id) => ({ type: 'app:split-tab', orientation: 'h', ratios: [1, 1, 1], children: [], ...(id ? { [marker]: id } : {}) })
const pane = id => ({ profile: { id, name: id }, session: { open: true, profile: { id } }, parent: null })
function layout(id, children, extra = {}) {
    const root = { _recoveredState: token(id), getAllTabs: () => children, getRecoveryToken: async () => token(), destroyed$: new Subject(), ...extra }
    children.forEach(child => { child.parent = root })
    return root
}
function setup(tabs = [], implementation) {
    const app = { tabs, tabOpened$: new Subject(), tabsChanged$: new Subject() }
    const config = { ready$: new Subject(), store: { profiles: [] } }
    const profiles = { newTabParametersForProfile: implementation || (async profile => ({ type: 'Split', inputs: { _recoveredState: profile.options.recoveryToken, title: profile.name } })) }
    const original = profiles.newTabParametersForProfile
    const service = new MetricScopeService(config, app, profiles)
    return { service, app, config, profiles, original }
}
function ids(service, leaf) { return service.contextForSession(leaf.session).profileIds.sort() }

test('mixed saved layout P1/P2/P1 matches each leaf and its layout, never sibling profiles', () => {
    const panes = [pane('P1'), pane('P2'), pane('P1')]
    const { service } = setup([layout('layout4', panes)])
    assert.deepEqual(ids(service, panes[0]), ['P1', 'layout4'])
    assert.deepEqual(ids(service, panes[1]), ['P2', 'layout4'])
    assert.deepEqual(ids(service, panes[2]), ['P1', 'layout4'])
    service.ngOnDestroy()
})

test('leaf identity wins over session fallback and ignores titles/hosts', () => {
    const leaf = pane('connection-id')
    leaf.profile.name = 'Renamed connection'
    leaf.session.profile.id = 'transport-id'
    const { service } = setup([leaf])
    assert.deepEqual(ids(service, leaf), ['connection-id'])
    delete leaf.profile
    assert.deepEqual(ids(service, leaf), ['transport-id'])
    leaf.session.open = false
    assert.deepEqual(ids(service, leaf), [])
    service.ngOnDestroy()
})

test('opening a layout stamps a deep copy without modifying the saved profile or provider parameters', async () => {
    const stored = { id: 'layout4', name: 'P4 Three panes', type: 'split-layout', options: { recoveryToken: token('old-layout') } }
    stored.options.recoveryToken.children.push({ profile: { id: 'P1' } })
    let providerResult
    const { service, profiles } = setup([], async profile => providerResult = { type: 'Split', inputs: { title: 'Preserved', _recoveredState: profile.options.recoveryToken } })
    const params = await profiles.newTabParametersForProfile(stored)
    assert.equal(params.inputs.title, 'Preserved')
    assert.equal(params.inputs._recoveredState[marker], 'layout4')
    assert.equal(stored.options.recoveryToken[marker], 'old-layout')
    assert.equal(providerResult.inputs._recoveredState, stored.options.recoveryToken)
    params.inputs._recoveredState.children[0].profile.id = 'changed'
    assert.equal(stored.options.recoveryToken.children[0].profile.id, 'P1')
    service.ngOnDestroy()
})

test('two concurrently opened layouts with identical content retain their distinct IDs', async () => {
    const resolvers = {}
    const { service, profiles, app } = setup([], profile => new Promise(resolve => { resolvers[profile.id] = () => resolve({ inputs: { _recoveredState: profile.options.recoveryToken } }) }))
    const first = profiles.newTabParametersForProfile({ id: 'layoutA', type: 'split-layout', options: { recoveryToken: token() } })
    const second = profiles.newTabParametersForProfile({ id: 'layoutB', type: 'split-layout', options: { recoveryToken: token() } })
    resolvers.layoutB(); resolvers.layoutA()
    const [a, b] = await Promise.all([first, second])
    const panes = [pane('P1'), pane('P1')]
    app.tabs = [layout(null, [panes[0]], a.inputs), layout(null, [panes[1]], b.inputs)]
    app.tabsChanged$.next()
    assert.deepEqual(ids(service, panes[0]), ['P1', 'layoutA'])
    assert.deepEqual(ids(service, panes[1]), ['P1', 'layoutB'])
    service.ngOnDestroy()
})

test('layout identity is persisted in recovery tokens and survives normal Tabby restoration', async () => {
    const child = pane('P1')
    const root = layout('layout4', [child])
    const raw = token()
    root.getRecoveryToken = async () => raw
    const first = setup([root])
    const saved = await root.getRecoveryToken({ includeState: true })
    assert.equal(saved[marker], 'layout4')
    assert.equal(raw[marker], undefined)
    first.service.ngOnDestroy()
    // SplitTabRecoveryProvider returns inputs._recoveredState = saved token.
    const restoredChild = pane('P2')
    const restoredRoot = layout(null, [restoredChild], { _recoveredState: saved })
    const second = setup([restoredRoot])
    assert.deepEqual(ids(second.service, restoredChild), ['P2', 'layout4'])
    assert.equal((await restoredRoot.getRecoveryToken())[marker], 'layout4')
    second.service.ngOnDestroy()
})

test('moving a pane changes layout membership using actual parent links', () => {
    const child = pane('P1')
    const childrenA = [child], childrenB = []
    const rootA = layout('layoutA', childrenA), rootB = layout('layoutB', childrenB)
    const { service, app } = setup([rootA, rootB])
    assert.deepEqual(ids(service, child), ['P1', 'layoutA'])
    childrenA.splice(0, 1); app.tabs.push(child); child.parent = null
    assert.deepEqual(ids(service, child), ['P1'])
    app.tabs.pop(); childrenB.push(child); child.parent = rootB
    assert.deepEqual(ids(service, child), ['P1', 'layoutB'])
    service.ngOnDestroy()
})

test('already open unmarked layouts do not acquire identity from equal names or content', () => {
    const child = pane('P1')
    const { service, config } = setup([layout(null, [child], { title: 'P4 Three panes' })])
    config.store.profiles = [{ id: 'layout4', type: 'split-layout', name: 'P4 Three panes', options: { recoveryToken: token() } }]
    assert.deepEqual(ids(service, child), ['P1'])
    service.ngOnDestroy()
})

test('deleted profile/layout selections remain fail-closed instead of becoming global', () => {
    const child = pane('P1')
    const { service } = setup([layout('layout4', [child])])
    const scope = { mode: 'selected', profileIds: ['layout4'] }
    const context = service.contextForSession(child.session)
    assert.equal(matchesScope(scope, context, [{ id: 'layout4' }]), true)
    assert.equal(matchesScope(scope, context, [{ id: 'new-layout', name: 'same name' }]), false)
    assert.equal(matchesScope({ mode: 'selected', profileIds: [] }, context, []), false)
    service.ngOnDestroy()
})

test('ordinary profiles and null provider results are unchanged', async () => {
    const originalParams = { inputs: { profile: { id: 'P1' } } }
    const first = setup([], async () => originalParams)
    assert.equal(await first.profiles.newTabParametersForProfile({ id: 'P1', type: 'ssh' }), originalParams)
    first.service.ngOnDestroy()
    const second = setup([], async () => null)
    assert.equal(await second.profiles.newTabParametersForProfile({ id: 'layout', type: 'split-layout' }), null)
    second.service.ngOnDestroy()
})

test('destroy cleanup restores owned methods and releases per-tab subscriptions', () => {
    const root = layout('layout4', [pane('P1')])
    const getToken = root.getRecoveryToken
    const { service, app, config, profiles, original } = setup([root])
    assert.notEqual(root.getRecoveryToken, getToken)
    assert.equal(root.destroyed$.observers.length, 1)
    root.destroyed$.next()
    assert.equal(root.getRecoveryToken, getToken)
    assert.equal(root.destroyed$.observers.length, 0)
    service.ngOnDestroy()
    assert.equal(profiles.newTabParametersForProfile, original)
    assert.equal(app.tabsChanged$.observers.length, 0)
    assert.equal(config.ready$.observers.length, 0)
})

test('cleanup does not overwrite hooks installed later by another plugin', () => {
    const root = layout('layout4', [])
    const { service, profiles } = setup([root])
    const externalTokenHook = async () => null, externalProfileHook = async () => null
    root.getRecoveryToken = externalTokenHook
    profiles.newTabParametersForProfile = externalProfileHook
    service.ngOnDestroy()
    assert.equal(root.getRecoveryToken, externalTokenHook)
    assert.equal(profiles.newTabParametersForProfile, externalProfileHook)
})

test('late profile result after service destruction is not annotated', async () => {
    let complete
    const result = { inputs: { _recoveredState: token() } }
    const { service, profiles } = setup([], () => new Promise(resolve => { complete = resolve }))
    const promise = profiles.newTabParametersForProfile({ id: 'layout4', type: 'split-layout' })
    service.ngOnDestroy()
    complete(result)
    assert.equal(await promise, result)
    assert.equal(result.inputs._recoveredState[marker], undefined)
})

test('ancestor traversal handles nested layouts and malformed parent cycles without sibling union', () => {
    const child = pane('P1')
    const inner = layout('inner', [child])
    const outer = layout('outer', [inner])
    outer.parent = inner
    const { service } = setup([outer])
    assert.deepEqual(ids(service, child), ['P1', 'inner', 'outer'])
    service.ngOnDestroy()
})
