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

// Saved split layouts contain a snapshot of the original SSH profile. Tabby
// restores that snapshot even when the current saved connection has a new ID.
function sshPane(id, options = {}) {
    const child = pane(id)
    child.profile = { id, type: 'ssh', name: 'Saved SSH connection', options: {
        host: 'node.example.test', port: 2201, user: 'analyst', ...options,
    } }
    child.session.profile = child.profile
    return child
}

function savedSSH(id, options = {}) {
    return sshPane(id, options).profile
}

test('stale layout SSH snapshot also matches its unique current saved connection', () => {
    const child = sshPane('old-container', { host: ' NODE.EXAMPLE.TEST ', port: '2201' })
    const { service, config } = setup([layout('mixed-layout', [child])])
    config.store.profiles = [savedSSH('current-container'), { id: 'mixed-layout', type: 'split-layout' }]
    const context = service.contextForSession(child.session)
    assert.deepEqual(context.profileIds.sort(), ['current-container', 'mixed-layout', 'old-container'])
    assert.equal(matchesScope({ mode: 'selected', profileIds: ['current-container'] }, context, config.store.profiles), true)
    // The alias is runtime context only: never mutate saved layout snapshots.
    assert.equal(child.profile.id, 'old-container')
    assert.equal(child.profile.options.port, '2201')
    service.ngOnDestroy()
})

test('a current saved SSH ID remains authoritative even with another identical endpoint', () => {
    const child = sshPane('original')
    const { service, config } = setup([child])
    config.store.profiles = [savedSSH('original'), savedSSH('same-endpoint')]
    assert.deepEqual(ids(service, child), ['original'])
    service.ngOnDestroy()
})

test('a stale SSH snapshot never aliases a different port or username', () => {
    const child = sshPane('old-container')
    const { service, config } = setup([child])
    config.store.profiles = [
        savedSSH('other-port', { port: 2202 }),
        savedSSH('other-user', { user: 'Analyst' }),
        savedSSH('other-host', { host: 'other.example.test' }),
    ]
    assert.deepEqual(ids(service, child), ['old-container'])
    service.ngOnDestroy()
})

test('ambiguous saved SSH endpoints do not select either connection', () => {
    const child = sshPane('old-container')
    const { service, config } = setup([child])
    config.store.profiles = [savedSSH('copy-one'), savedSSH('copy-two')]
    const context = service.contextForSession(child.session)
    assert.deepEqual(context.profileIds, ['old-container'])
    for (const id of ['copy-one', 'copy-two']) {
        assert.equal(matchesScope({ mode: 'selected', profileIds: [id] }, context, config.store.profiles), false)
    }
    service.ngOnDestroy()
})

test('nested layouts resolve each stale SSH leaf without collecting sibling aliases', () => {
    const first = sshPane('old-one')
    const second = sshPane('old-two', { port: 2202 })
    const root = layout('outer-layout', [layout('inner-layout', [first, second])])
    const { service, config } = setup([root])
    config.store.profiles = [savedSSH('current-one'), savedSSH('current-two', { port: 2202 })]
    assert.deepEqual(ids(service, first), ['current-one', 'inner-layout', 'old-one', 'outer-layout'])
    assert.deepEqual(ids(service, second), ['current-two', 'inner-layout', 'old-two', 'outer-layout'])
    service.ngOnDestroy()
})

test('endpoint aliasing never revives a deleted selected profile ID or broadens empty selections', () => {
    const child = sshPane('deleted')
    const { service, config } = setup([child])
    config.store.profiles = [savedSSH('replacement')]
    const context = service.contextForSession(child.session)
    assert.equal(matchesScope({ mode: 'selected', profileIds: ['deleted'] }, context, config.store.profiles), false)
    assert.equal(matchesScope({ mode: 'selected', profileIds: [] }, context, config.store.profiles), false)
    assert.equal(matchesScope({ mode: 'selected', profileIds: ['replacement'] }, context, config.store.profiles), true)
    config.store.profiles = []
    assert.deepEqual(ids(service, child), ['deleted'])
    service.ngOnDestroy()
})

test('stale SSH endpoint matching normalizes the default port and excludes missing identities', () => {
    const child = sshPane('old', { port: undefined })
    const { service, config } = setup([child])
    config.store.profiles = [savedSSH('current', { port: 22 })]
    assert.deepEqual(ids(service, child), ['current', 'old'])
    child.profile.options.host = ''
    assert.deepEqual(ids(service, child), ['old'])
    child.profile.options.host = 'node.example.test'
    child.profile.options.user = ''
    assert.deepEqual(ids(service, child), ['old'])
    service.ngOnDestroy()
})

test('matching SSH endpoints on different proxy or jump routes remain distinct', () => {
    const child = sshPane('old-container')
    const { service, config } = setup([child])
    for (const route of [
        { jumpHost: 'jump-a' },
        { proxyCommand: 'ssh jump-a -W %h:%p' },
        { socksProxyHost: 'proxy.example.test', socksProxyPort: 1080 },
        { httpProxyHost: 'proxy.example.test', httpProxyPort: 8080 },
    ]) {
        config.store.profiles = [savedSSH('other-route', route)]
        assert.deepEqual(ids(service, child), ['old-container'])
    }
    service.ngOnDestroy()
})

test('SSH endpoint aliasing never reads authentication secrets', () => {
    const child = sshPane('old')
    const current = savedSSH('current')
    for (const options of [child.profile.options, current.options]) {
        for (const key of ['password', 'privateKeys']) {
            Object.defineProperty(options, key, { get() { throw new Error('Must not inspect authentication'); } })
        }
    }
    const { service, config } = setup([child])
    config.store.profiles = [current]
    assert.deepEqual(ids(service, child), ['current', 'old'])
    service.ngOnDestroy()
})

test('temporary SSH connections without a saved ID do not acquire a selected profile scope', () => {
    const child = sshPane(undefined)
    const { service, config } = setup([child])
    config.store.profiles = [savedSSH('current')]
    assert.deepEqual(ids(service, child), [])
    service.ngOnDestroy()
})

test('a stale session snapshot can resolve before its owning tab is registered', () => {
    const child = sshPane('old')
    const { service, config } = setup([])
    config.store.profiles = [savedSSH('current')]
    assert.deepEqual(ids(service, child), ['current', 'old'])
    child.session.open = false
    assert.deepEqual(ids(service, child), [])
    service.ngOnDestroy()
})

test('stale SSH matching resolves inherited connection fields through the Tabby profile service', () => {
    const child = sshPane('old', { jumpHost: 'lab-jump' })
    const { service, config, profiles } = setup([child])
    const raw = { id: 'current', type: 'ssh', group: 'lab', options: { port: 2201 } }
    config.store.profiles = [raw]
    profiles.getConfigProxyForProfile = candidate => {
        assert.equal(candidate, raw)
        return { ...candidate, options: { host: 'node.example.test', user: 'analyst', jumpHost: 'lab-jump', ...candidate.options } }
    }
    assert.deepEqual(ids(service, child), ['current', 'old'])
    assert.deepEqual(raw.options, { port: 2201 }, 'resolving defaults must not edit the saved profile')
    profiles.getConfigProxyForProfile = () => { throw new Error('Profile provider unavailable') }
    assert.deepEqual(ids(service, child), ['old'], 'a failed provider must not break all metric rendering')
    service.ngOnDestroy()
})

test('SSH aliases are re-evaluated when saved connections are removed, changed or recreated', () => {
    const child = sshPane('old')
    const { service, config } = setup([child])
    config.store.profiles = [savedSSH('first')]
    assert.deepEqual(ids(service, child), ['first', 'old'])
    config.store.profiles[0].options.port = 2202
    assert.deepEqual(ids(service, child), ['old'])
    config.store.profiles = []
    assert.deepEqual(ids(service, child), ['old'])
    config.store.profiles = [savedSSH('second')]
    assert.deepEqual(ids(service, child), ['old', 'second'])
    config.store.profiles.push(savedSSH('third'))
    assert.deepEqual(ids(service, child), ['old'], 'new ambiguity must remove an earlier alias')
    service.ngOnDestroy()
})
