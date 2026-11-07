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
const { MetricScopeService, LAYOUT_SCOPE_MARKER: marker, INSTANCE_VISIBILITY_MARKER } = require('../src/services/metric-scope.service.ts')
const { matchesScope, getLayoutPaneTargets, layoutLeafTokens, PANE_SCOPE_MARKER } = require('../src/display-scope.ts')

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

function savedPaneLayout(id, profiles) {
    return { id, type: 'split-layout', name: id, options: { recoveryToken: {
        type: 'app:split-tab', children: profiles.map(profile => ({ type: 'app:ssh-tab', profile })),
    } } }
}

test('opening a saved layout stamps distinct pane identities without changing its stored snapshots', async () => {
    const saved = savedPaneLayout('layout', [savedSSH('deleted'), savedSSH('deleted')])
    const before = JSON.stringify(saved)
    const { service, config, profiles, app } = setup()
    config.store.profiles = [saved]
    const params = await profiles.newTabParametersForProfile(saved)
    const snapshots = layoutLeafTokens(params.inputs._recoveredState)
    const children = snapshots.map(entry => ({ profile: entry.token.profile, session: { open: true, profile: entry.token.profile } }))
    const root = layout(null, children, params.inputs)
    app.tabs = [root]
    const targets = getLayoutPaneTargets(config.store.profiles)
    assert.notEqual(snapshots[0].token.profile[PANE_SCOPE_MARKER], snapshots[1].token.profile[PANE_SCOPE_MARKER])
    assert.equal(JSON.stringify(saved), before)
    const scope = { mode: 'selected', profileIds: [targets[0].id] }
    assert.equal(matchesScope(scope, service.contextForSession(children[0].session), config.store.profiles), true)
    assert.equal(matchesScope(scope, service.contextForSession(children[1].session), config.store.profiles), false)
    service.ngOnDestroy()
})

test('marked pane identity survives recovery and keeps per-pane opt-outs through repeated connections', async () => {
    const saved = savedPaneLayout('layout', [savedSSH('shared'), savedSSH('shared')])
    const first = setup()
    first.config.store.profiles = [savedSSH('shared'), saved]
    const params = await first.profiles.newTabParametersForProfile(saved)
    const children = layoutLeafTokens(params.inputs._recoveredState).map(entry => ({ profile: entry.token.profile, session: { open: true, profile: entry.token.profile } }))
    const root = layout(null, children, params.inputs)
    root.getRecoveryToken = async () => ({ type: 'app:split-tab', children: children.map(child => ({ type: 'app:ssh-tab', profile: child.profile })) })
    first.app.tabs = [root]
    first.app.tabsChanged$.next()
    const recovered = await root.getRecoveryToken()
    first.service.ngOnDestroy()
    const restored = recovered.children.map(entry => ({ profile: entry.profile, session: { open: true, profile: entry.profile } }))
    const second = setup([layout(null, restored, { _recoveredState: recovered })])
    second.config.store.profiles = [savedSSH('shared'), saved]
    const targets = getLayoutPaneTargets(second.config.store.profiles)
    const scope = { mode: 'selected', profileIds: ['shared', 'layout'], excludedProfileIds: [targets[0].id] }
    assert.equal(matchesScope(scope, second.service.contextForSession(restored[0].session), second.config.store.profiles), false)
    assert.equal(matchesScope(scope, second.service.contextForSession(restored[1].session), second.config.store.profiles), true)
    second.service.ngOnDestroy()
})

test('existing marked layouts acquire child identities only after their complete leaf sequence matches', async () => {
    const profiles = [savedSSH('old-one'), savedSSH('old-two', { port: 2202 })]
    const saved = savedPaneLayout('layout', profiles)
    // Different nested tree shape is normalized by Tabby, while leaf order stays intact.
    saved.options.recoveryToken.children = [{ type: 'app:split-tab', children: saved.options.recoveryToken.children }]
    const children = profiles.map(profile => ({ profile, session: { open: true, profile } }))
    const state = JSON.parse(JSON.stringify(saved.options.recoveryToken))
    state[marker] = 'layout'
    const root = layout(null, children, { _recoveredState: state })
    root.getRecoveryToken = async () => ({ type: 'app:split-tab', children: children.map(child => ({ type: 'app:ssh-tab', profile: child.profile })) })
    const { service, config } = setup([root])
    config.store.profiles = [saved]
    const targets = getLayoutPaneTargets(config.store.profiles)
    assert(service.contextForSession(children[0].session).profileIds.includes(targets[0].id))
    assert(service.contextForSession(children[1].session).profileIds.includes(targets[1].id))
    const recovery = await root.getRecoveryToken()
    assert.equal(recovery.children[0].profile[PANE_SCOPE_MARKER], targets[0].id)
    assert.equal(children[0].profile[PANE_SCOPE_MARKER], undefined, 'legacy upgrade must not edit the stored profile')
    service.ngOnDestroy()

    // A skipped or unknown leaf makes positional inference unsafe.
    const altered = setup([layout(null, [children[0]], { _recoveredState: state })])
    altered.config.store.profiles = [saved]
    assert(!altered.service.contextForSession(children[0].session).profileIds.includes(targets[0].id))
    altered.service.ngOnDestroy()
})

test('moving a pane preserves its identity within its layout and drops it outside that layout', async () => {
    const saved = savedPaneLayout('layout', [savedSSH('same'), savedSSH('same')])
    const { service, config, profiles, app } = setup()
    config.store.profiles = [saved]
    const params = await profiles.newTabParametersForProfile(saved)
    const children = layoutLeafTokens(params.inputs._recoveredState).map(entry => ({ profile: entry.token.profile, session: { open: true, profile: entry.token.profile } }))
    const root = layout(null, children, params.inputs)
    app.tabs = [root]
    const target = getLayoutPaneTargets(config.store.profiles)[0]
    const child = children[0]
    children.reverse()
    assert(service.contextForSession(child.session).profileIds.includes(target.id), 'reordering live panes must not exchange their IDs')
    children.splice(children.indexOf(child), 1)
    child.parent = null; app.tabs.push(child)
    assert(!service.contextForSession(child.session).profileIds.includes(target.id))
    const other = layout('another-layout', [child])
    app.tabs = [root, other]
    assert(!service.contextForSession(child.session).profileIds.includes(target.id))
    service.ngOnDestroy()
})

test('removed or replaced saved pane targets do not survive in a restored runtime context', async () => {
    const saved = savedPaneLayout('layout', [savedSSH('old')])
    const { service, config, profiles, app } = setup()
    config.store.profiles = [saved]
    const params = await profiles.newTabParametersForProfile(saved)
    const profile = params.inputs._recoveredState.children[0].profile
    const child = { profile, session: { open: true, profile } }
    app.tabs = [layout(null, [child], params.inputs)]
    const target = getLayoutPaneTargets(config.store.profiles)[0]
    assert(service.contextForSession(child.session).profileIds.includes(target.id))
    saved.options.recoveryToken.children[0].profile = savedSSH('replacement')
    assert(!service.contextForSession(child.session).profileIds.includes(target.id))
    config.store.profiles = []
    assert(!service.contextForSession(child.session).profileIds.includes(target.id))
    service.ngOnDestroy()
})

test('ConfigProxy-hidden pane markers survive reordered repeated connections and recovery without swapping exclusions', async () => {
    // Like Tabby's ConfigProxy, only provider-default keys have visible getters.
    const proxy = raw => {
        const result = {}
        for (const key of ['id', 'type', 'name', 'options']) {
            Object.defineProperty(result, key, { enumerable: true, get: () => raw[key] })
        }
        result.__getValue = key => {
            assert([PANE_SCOPE_MARKER, INSTANCE_VISIBILITY_MARKER].includes(key), 'only known plugin markers may be read from raw config')
            return raw[key]
        }
        return result
    }
    const saved = savedPaneLayout('layout', [savedSSH('same'), savedSSH('same')])
    const first = setup()
    first.config.store.profiles = [saved]
    const params = await first.profiles.newTabParametersForProfile(saved)
    const children = layoutLeafTokens(params.inputs._recoveredState).map(entry => {
        const profile = proxy(entry.token.profile)
        assert.equal(profile[PANE_SCOPE_MARKER], undefined)
        return { profile, session: { open: true, profile } }
    })
    const root = layout(null, children, params.inputs)
    root.getRecoveryToken = async () => ({ type: 'app:split-tab', children: children.map(child => ({ type: 'app:ssh-tab', profile: child.profile })) })
    first.app.tabs = [root]
    first.app.tabsChanged$.next()
    const [one, two] = getLayoutPaneTargets(first.config.store.profiles)
    const firstChild = children[0]
    children.reverse()
    assert(first.service.contextForSession(firstChild.session).profileIds.includes(one.id))
    assert(!first.service.contextForSession(firstChild.session).profileIds.includes(two.id))
    const recovery = JSON.parse(JSON.stringify(await root.getRecoveryToken()))
    assert.equal(recovery.children[0].profile[PANE_SCOPE_MARKER], two.id)
    assert.equal(recovery.children[1].profile[PANE_SCOPE_MARKER], one.id)
    first.service.ngOnDestroy()
    const restored = recovery.children.map(entry => {
        const profile = proxy(entry.profile)
        return { profile, session: { open: true, profile } }
    })
    const second = setup([layout(null, restored, { _recoveredState: recovery })])
    second.config.store.profiles = [saved]
    const scope = { mode: 'selected', profileIds: ['layout'], excludedProfileIds: [one.id] }
    assert.equal(matchesScope(scope, second.service.contextForSession(restored[0].session), second.config.store.profiles), true)
    assert.equal(matchesScope(scope, second.service.contextForSession(restored[1].session), second.config.store.profiles), false)
    second.service.ngOnDestroy()
})

test('legacy recovery uses a marker in its saved token before deriving a new positional identity', () => {
    const saved = savedPaneLayout('layout', [savedSSH('same'), savedSSH('same')])
    const [one, two] = getLayoutPaneTargets([saved])
    const state = JSON.parse(JSON.stringify(saved.options.recoveryToken))
    state[marker] = 'layout'
    state.children[0].profile[PANE_SCOPE_MARKER] = two.id
    state.children[1].profile[PANE_SCOPE_MARKER] = one.id
    const children = [sshPane('same'), sshPane('same')]
    const { service, config } = setup([layout(null, children, { _recoveredState: state })])
    config.store.profiles = [saved]
    assert(service.contextForSession(children[0].session).profileIds.includes(two.id))
    assert(service.contextForSession(children[1].session).profileIds.includes(one.id))
    service.ngOnDestroy()
})

async function openSavedPaneLayout(env, saved) {
    const params = await env.profiles.newTabParametersForProfile(saved)
    const children = layoutLeafTokens(params.inputs._recoveredState).map(entry => {
        const profile = entry.token.profile
        return { profile, session: { open: true, profile } }
    })
    const root = layout(null, children, params.inputs)
    env.app.tabs.push(root)
    env.app.tabsChanged$.next()
    return { root, children }
}

test('three same-connection panes persist independent false/false/true visibility when a saved layout is reopened', async () => {
    const shared = savedSSH('same')
    const saved = savedPaneLayout('layout', [shared, shared, shared])
    const before = JSON.stringify(saved)
    const first = setup()
    first.config.store.profiles = [shared, saved]
    let saves = 0
    first.config.save = () => { saves++ }
    const { children } = await openSavedPaneLayout(first, saved)
    first.service.setPaneVisible(children[0].session, false)
    first.service.setPaneVisible(children[1].session, false)
    assert.deepEqual(children.map(child => first.service.isPaneVisible(child.session)), [false, false, true])
    assert.equal(saves, 2)
    assert.equal(JSON.stringify(saved), before, 'visibility must not alter the shared saved connection or layout')
    const savedVisibility = JSON.parse(JSON.stringify(first.config.store.plugin.serverStats.paneVisibility))
    assert.equal(Object.keys(savedVisibility).length, 2)
    first.service.ngOnDestroy()
    const second = setup()
    second.config.store.profiles = [shared, saved]
    second.config.store.plugin = { serverStats: { paneVisibility: savedVisibility } }
    const reopened = await openSavedPaneLayout(second, saved)
    assert.deepEqual(reopened.children.map(child => second.service.isPaneVisible(child.session)), [false, false, true])
    second.service.setPaneVisible(reopened.children[0].session, true)
    assert.deepEqual(reopened.children.map(child => second.service.isPaneVisible(child.session)), [true, false, true])
    second.service.ngOnDestroy()
})

test('visibility is isolated between layouts and deleted/replaced pane targets do not reuse old hidden flags', async () => {
    const savedA = savedPaneLayout('layout-a', [savedSSH('same')])
    const savedB = savedPaneLayout('layout-b', [savedSSH('same')])
    const env = setup()
    env.config.store.profiles = [savedA, savedB]
    const a = await openSavedPaneLayout(env, savedA)
    const b = await openSavedPaneLayout(env, savedB)
    env.service.setPaneVisible(a.children[0].session, false)
    assert.equal(env.service.isPaneVisible(a.children[0].session), false)
    assert.equal(env.service.isPaneVisible(b.children[0].session), true)
    savedA.options.recoveryToken.children[0].profile = savedSSH('replacement')
    const replacement = await openSavedPaneLayout(env, savedA)
    assert.equal(env.service.isPaneVisible(replacement.children[0].session), true)
    env.config.store.profiles = [savedB]
    assert.equal(env.service.isPaneVisible(a.children[0].session), true)
    env.service.ngOnDestroy()
})

test('standalone panes using one shared profile persist distinct instance visibility without modifying that profile', async () => {
    const shared = savedSSH('shared')
    const makeLeaf = profile => ({ profile, session: { open: true, profile }, destroyed$: new Subject(),
        getRecoveryToken: async () => ({ type: 'app:ssh-tab', profile }) })
    const one = makeLeaf(shared), two = makeLeaf(shared)
    const originalRecovery = one.getRecoveryToken
    const env = setup([one, two])
    env.config.store.profiles = [shared]
    env.service.setPaneVisible(one.session, false)
    assert.equal(env.service.isPaneVisible(one.session), false)
    assert.equal(env.service.isPaneVisible(two.session), true)
    assert.equal(shared[INSTANCE_VISIBILITY_MARKER], undefined)
    const recovered = JSON.parse(JSON.stringify(await one.getRecoveryToken({ includeState: true })))
    assert.match(recovered.profile[INSTANCE_VISIBILITY_MARKER], /^pane-instance:[a-f0-9]{32}$/)
    assert.equal(recovered.profile.id, shared.id)
    const savedVisibility = JSON.parse(JSON.stringify(env.config.store.plugin.serverStats.paneVisibility))
    env.service.ngOnDestroy()
    assert.equal(one.getRecoveryToken, originalRecovery)
    assert.equal(one.destroyed$.observers.length, 0)
    // A fresh connection opened from the saved profile is still independent.
    const reopened = makeLeaf(shared)
    const restored = makeLeaf(recovered.profile)
    const next = setup([reopened, restored])
    next.config.store.profiles = [shared]
    next.config.store.plugin = { serverStats: { paneVisibility: savedVisibility } }
    assert.equal(next.service.isPaneVisible(restored.session), false)
    assert.equal(next.service.isPaneVisible(reopened.session), true)
    next.service.setPaneVisible(reopened.session, false)
    next.service.setPaneVisible(restored.session, true)
    assert.equal(next.service.isPaneVisible(reopened.session), false)
    assert.equal(next.service.isPaneVisible(restored.session), true)
    next.service.ngOnDestroy()
})

test('ConfigProxy-hidden standalone visibility identity survives recovery and reconnects', async () => {
    const key = 'pane-instance:' + 'b'.repeat(32)
    const raw = { ...savedSSH('saved'), [INSTANCE_VISIBILITY_MARKER]: key }
    const profile = { id: raw.id, type: raw.type, options: raw.options,
        __getValue: field => field === INSTANCE_VISIBILITY_MARKER ? key : undefined }
    const child = { profile, session: { open: true, profile }, getRecoveryToken: async () => ({ type: 'app:ssh-tab', profile }) }
    const env = setup([child])
    env.config.store.profiles = [savedSSH('saved')]
    env.config.store.plugin = { serverStats: { paneVisibility: { [key]: false } } }
    assert.equal(env.service.isPaneVisible(child.session), false)
    child.session = { open: true, profile }
    assert.equal(env.service.isPaneVisible(child.session), false)
    assert.equal((await child.getRecoveryToken({ includeState: true })).profile[INSTANCE_VISIBILITY_MARKER], key)
    env.service.ngOnDestroy()
})

test('duplicating a hidden standalone pane strips its old recovery identity and creates an independent toggle', async () => {
    const shared = savedSSH('same')
    const child = { profile: shared, session: { open: true, profile: shared },
        getRecoveryToken: async () => ({ type: 'app:ssh-tab', profile: shared }) }
    const env = setup([child])
    env.config.store.profiles = [shared]
    env.service.setPaneVisible(child.session, false)
    const oldKey = env.service.visibilityKey(child.session)
    const recovery = await child.getRecoveryToken({ includeState: true })
    assert.equal(recovery.profile[INSTANCE_VISIBILITY_MARKER], oldKey)
    // Duplicate uses no options, unlike actual session recovery.
    const copied = await child.getRecoveryToken()
    assert.notEqual(copied.profile[INSTANCE_VISIBILITY_MARKER], oldKey)
    assert.match(copied.profile[INSTANCE_VISIBILITY_MARKER], /^pane-instance:[a-f0-9]{32}$/)
    const duplicate = { profile: copied.profile, session: { open: true, profile: copied.profile },
        getRecoveryToken: async () => copied }
    env.app.tabs.push(duplicate)
    assert.equal(env.service.isPaneVisible(duplicate.session), true)
    env.service.setPaneVisible(duplicate.session, false)
    assert.notEqual(env.service.visibilityKey(duplicate.session), oldKey)
    env.service.setPaneVisible(child.session, true)
    assert.equal(env.service.isPaneVisible(child.session), true)
    assert.equal(env.service.isPaneVisible(duplicate.session), false)
    env.service.ngOnDestroy()
})

test('a duplicated layout pane does not reuse its source slot even after the original pane is removed', async () => {
    const saved = savedPaneLayout('layout', [savedSSH('same')])
    const env = setup()
    env.config.store.profiles = [saved]
    const { root, children } = await openSavedPaneLayout(env, saved)
    const original = children[0]
    original.getRecoveryToken = async () => ({ type: 'app:ssh-tab', profile: original.profile })
    env.app.tabsChanged$.next()
    env.service.setPaneVisible(original.session, false)
    const oldKey = env.service.visibilityKey(original.session)
    const copied = await original.getRecoveryToken()
    assert.equal(copied.profile[PANE_SCOPE_MARKER], undefined)
    assert.match(copied.profile[INSTANCE_VISIBILITY_MARKER], /^pane-instance:[a-f0-9]{32}$/)
    const duplicate = { profile: copied.profile, session: { open: true, profile: copied.profile }, parent: root,
        getRecoveryToken: async () => copied }
    children.push(duplicate)
    assert.equal(env.service.isPaneVisible(duplicate.session), true)
    assert(!env.service.contextForSession(duplicate.session).profileIds.includes(oldKey))
    // The raw profile-ID sequence now looks like the initial saved layout again.
    // It must not make this newly created pane inherit the old slot or hidden flag.
    children.splice(0, 1); original.parent = null
    assert.equal(env.service.isPaneVisible(duplicate.session), true)
    assert(!env.service.contextForSession(duplicate.session).profileIds.includes(oldKey))
    env.service.setPaneVisible(duplicate.session, false)
    assert.notEqual(env.service.visibilityKey(duplicate.session), oldKey)
    env.service.ngOnDestroy()
})

test('duplicate recovery removes hidden ConfigProxy identifiers as well as visible marker properties', async () => {
    const key = 'pane-instance:' + 'd'.repeat(32)
    const raw = { ...savedSSH('same'), [INSTANCE_VISIBILITY_MARKER]: key }
    const profile = { id: raw.id, type: raw.type, options: raw.options,
        __getValue: field => raw[field] }
    const leaf = { profile, session: { open: true, profile }, getRecoveryToken: async () => ({ type: 'app:ssh-tab', profile }) }
    const env = setup([leaf])
    env.config.store.profiles = [savedSSH('same')]
    env.config.store.plugin = { serverStats: { paneVisibility: { [key]: false } } }
    const duplicate = await leaf.getRecoveryToken({ includeState: false })
    assert.notEqual(duplicate.profile[INSTANCE_VISIBILITY_MARKER], key)
    assert.match(duplicate.profile[INSTANCE_VISIBILITY_MARKER], /^pane-instance:[a-f0-9]{32}$/)
    assert.equal(duplicate.profile[PANE_SCOPE_MARKER], undefined)
    assert.equal(duplicate.profile.__getValue, undefined, 'a copied accessor must not expose the old raw identifier')
    assert.equal(profile.__getValue(INSTANCE_VISIBILITY_MARKER), key, 'the original proxy remains untouched')
    env.service.ngOnDestroy()
})

test('replacement duplicates retain independent visibility after restart, including duplicates never toggled', async () => {
    for (const explicitlyShown of [false, true]) {
        const saved = savedPaneLayout('layout', [savedSSH('same')])
        const env = setup()
        env.config.store.profiles = [saved]
        const params = await env.profiles.newTabParametersForProfile(saved)
        const makeLeaf = profile => ({ profile, session: { open: true, profile },
            getRecoveryToken: async () => ({ type: 'app:ssh-tab', profile }) })
        const original = makeLeaf(params.inputs._recoveredState.children[0].profile)
        const children = [original]
        const root = layout(null, children, { ...params.inputs, getRecoveryToken: async options => ({
            type: 'app:split-tab', children: await Promise.all(children.map(child => child.getRecoveryToken(options))),
        }) })
        env.app.tabs = [root]; env.app.tabsChanged$.next()
        env.service.setPaneVisible(original.session, false)
        const oldKey = env.service.visibilityKey(original.session)
        const copied = await original.getRecoveryToken()
        const duplicate = makeLeaf(copied.profile)
        duplicate.parent = root
        children.splice(0, 1, duplicate); original.parent = null
        env.app.tabsChanged$.next()
        if (explicitlyShown) env.service.setPaneVisible(duplicate.session, true)
        assert.equal(env.service.isPaneVisible(duplicate.session), true)
        const ownKey = env.service.visibilityKey(duplicate.session)
        assert.notEqual(ownKey, oldKey)
        const state = JSON.parse(JSON.stringify(await root.getRecoveryToken({ includeState: true })))
        assert.equal(state.children[0].profile[PANE_SCOPE_MARKER], undefined)
        assert.equal(state.children[0].profile[INSTANCE_VISIBILITY_MARKER], ownKey)
        const persisted = JSON.parse(JSON.stringify(env.config.store.plugin.serverStats.paneVisibility))
        env.service.ngOnDestroy()
        const restored = makeLeaf(state.children[0].profile)
        const next = setup([layout(null, [restored], { _recoveredState: state })])
        next.config.store.profiles = [saved]
        next.config.store.plugin = { serverStats: { paneVisibility: persisted } }
        assert.equal(next.service.visibilityKey(restored.session), ownKey)
        assert.equal(next.service.isPaneVisible(restored.session), true)
        assert(!next.service.contextForSession(restored.session).profileIds.includes(oldKey))
        next.service.ngOnDestroy()
    }
})

test('opening a newly saved layout gives explicit layout targets priority over inherited instance IDs', async () => {
    const inherited = { ...savedSSH('same'), [INSTANCE_VISIBILITY_MARKER]: 'pane-instance:' + 'a'.repeat(32) }
    const saved = savedPaneLayout('new-layout', [inherited])
    const env = setup()
    env.config.store.profiles = [saved]
    const [target] = getLayoutPaneTargets([saved])
    env.config.store.plugin = { serverStats: { paneVisibility: { [target.id]: false, [inherited[INSTANCE_VISIBILITY_MARKER]]: true } } }
    const { children } = await openSavedPaneLayout(env, saved)
    assert.equal(env.service.visibilityKey(children[0].session), target.id)
    assert.equal(env.service.isPaneVisible(children[0].session), false)
    env.service.ngOnDestroy()
})

test('saved-layout pane modes persist independently across reopen alongside visibility', async () => {
    const shared = savedSSH('same')
    const saved = savedPaneLayout('layout-modes', [shared, shared, shared])
    const other = savedPaneLayout('layout-other', [shared])
    const before = JSON.stringify([shared, saved, other])
    const first = setup()
    first.config.store.profiles = [shared, saved, other]
    let saves = 0
    first.config.save = () => { saves++ }
    const { children } = await openSavedPaneLayout(first, saved)
    const modes = ['overview', 'carousel', 'static']
    children.forEach((child, index) => first.service.setPaneGroupMode(child.session, modes[index]))
    first.service.setPaneVisible(children[0].session, false)
    first.service.setPaneVisible(children[1].session, false)
    assert.equal(saves, 5)
    assert.deepEqual(children.map(child => first.service.getPaneGroupMode(child.session)), modes)
    assert.deepEqual(children.map(child => first.service.isPaneVisible(child.session)), [false, false, true])
    assert.equal(JSON.stringify([shared, saved, other]), before, 'shared profile and layout definitions are never edited')
    const preferences = JSON.parse(JSON.stringify(first.config.store.plugin.serverStats))
    assert.equal(Object.keys(preferences.paneGroupModes).length, 3)
    first.service.ngOnDestroy()
    const next = setup()
    next.config.store.profiles = [shared, saved, other]
    next.config.store.plugin = { serverStats: preferences }
    const restored = await openSavedPaneLayout(next, saved)
    const separate = await openSavedPaneLayout(next, other)
    assert.deepEqual(restored.children.map(child => next.service.getPaneGroupMode(child.session)), modes)
    assert.deepEqual(restored.children.map(child => next.service.isPaneVisible(child.session)), [false, false, true])
    assert.equal(next.service.getPaneGroupMode(separate.children[0].session), undefined)
    next.service.setPaneGroupMode(restored.children[1].session, 'static')
    assert.equal(next.service.isPaneVisible(restored.children[1].session), false, 'mode selection does not unhide a pane')
    assert.equal(next.service.getPaneGroupMode(restored.children[0].session), 'overview')
    next.service.ngOnDestroy()
})

test('standalone mode-only preferences recover their identity and duplicate panes start independently', async () => {
    const shared = savedSSH('shared-mode')
    const makeLeaf = profile => ({ profile, session: { open: true, profile }, destroyed$: new Subject(),
        getRecoveryToken: async () => ({ type: 'app:ssh-tab', profile }) })
    const original = makeLeaf(shared), sibling = makeLeaf(shared)
    const recoveryMethod = original.getRecoveryToken
    const first = setup([original, sibling])
    first.config.store.profiles = [shared]
    first.service.setPaneGroupMode(original.session, 'carousel')
    assert.equal(first.service.isPaneVisible(original.session), true)
    assert.equal(first.service.getPaneGroupMode(sibling.session), undefined)
    assert.equal(shared[INSTANCE_VISIBILITY_MARKER], undefined)
    const originalKey = first.service.visibilityKey(original.session)
    const recovery = JSON.parse(JSON.stringify(await original.getRecoveryToken({ includeState: true })))
    assert.equal(recovery.profile[INSTANCE_VISIBILITY_MARKER], originalKey)
    const copied = await original.getRecoveryToken()
    const duplicate = makeLeaf(copied.profile)
    first.app.tabs.push(duplicate)
    assert.equal(first.service.getPaneGroupMode(duplicate.session), undefined)
    first.service.setPaneGroupMode(duplicate.session, 'static')
    assert.equal(first.service.getPaneGroupMode(original.session), 'carousel')
    const preferences = JSON.parse(JSON.stringify(first.config.store.plugin.serverStats))
    first.service.ngOnDestroy()
    assert.equal(original.getRecoveryToken, recoveryMethod)
    assert.equal(original.destroyed$.observers.length, 0, 'mode persistence hooks are released with the service')
    const restored = makeLeaf(recovery.profile)
    const restoredDuplicate = makeLeaf(copied.profile)
    const second = setup([restored, restoredDuplicate])
    second.config.store.profiles = [shared]
    second.config.store.plugin = { serverStats: preferences }
    assert.equal(second.service.getPaneGroupMode(restored.session), 'carousel')
    assert.equal(second.service.getPaneGroupMode(restoredDuplicate.session), 'static')
    second.service.ngOnDestroy()
})

test('pane mode preferences reject invalid values and ignore closed or destroyed sessions', () => {
    const key = 'pane-instance:' + 'e'.repeat(32)
    const raw = { ...savedSSH('mode-proxy'), [INSTANCE_VISIBILITY_MARKER]: key }
    const profile = { id: raw.id, type: raw.type, options: raw.options, __getValue: field => raw[field] }
    const leaf = { profile, session: { open: true, profile } }
    const env = setup([leaf])
    env.config.store.profiles = [savedSSH('mode-proxy')]
    env.config.store.plugin = { serverStats: { paneGroupModes: { [key]: 'bad', untouched: 'carousel' } } }
    let saves = 0
    env.config.save = () => { saves++ }
    assert.equal(env.service.getPaneGroupMode(leaf.session), undefined)
    env.service.setPaneGroupMode(leaf.session, 'bad')
    assert.equal(saves, 0)
    env.service.setPaneGroupMode(leaf.session, 'overview')
    assert.equal(saves, 1)
    assert.equal(env.service.getPaneGroupMode(leaf.session), 'overview', 'hidden ConfigProxy identities support modes too')
    assert.equal(env.config.store.plugin.serverStats.paneGroupModes.untouched, 'carousel')
    leaf.session.open = false
    env.service.setPaneGroupMode(leaf.session, 'static')
    assert.equal(env.service.getPaneGroupMode(leaf.session), undefined)
    env.service.setPaneGroupMode(null, 'static')
    env.service.ngOnDestroy()
    leaf.session.open = true
    env.service.setPaneGroupMode(leaf.session, 'static')
    assert.equal(env.service.getPaneGroupMode(leaf.session), undefined)
    assert.equal(saves, 1)
})
