import { Injectable, OnDestroy } from '@angular/core'
import { AppService, ConfigService, ProfilesService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { randomBytes } from 'crypto'
import { findSessionTab, getLayoutPaneTargets, layoutLeafTokens, layoutPaneId, LayoutPaneTarget, PANE_SCOPE_MARKER, resolveProfileScopeIds, ScopeContext } from '../display-scope'

/** A saved layout's origin, persisted in its recovery token, never inferred from titles. */
export const LAYOUT_SCOPE_MARKER = '__tabbyGroupServerStatsLayoutProfileId'
export const INSTANCE_VISIBILITY_MARKER = '__tabbyGroupServerStatsVisibilityId'
export type PaneGroupMode = 'overview' | 'carousel' | 'static'

interface TokenPatch {
    original: (...args: any[]) => any
    wrapped: (...args: any[]) => any
    hadOwnMethod: boolean
    destroyed?: Subscription
}

@Injectable({ providedIn: 'root' })
export class MetricScopeService implements OnDestroy {
    private subscriptions: Subscription[] = []
    private tokenPatches = new Map<any, TokenPatch>()
    private paneTargets = new WeakMap<any, Map<string, string>>()
    private legacyPanesObserved = new WeakSet<any>()
    private visibilityInstances = new WeakMap<any, string>()
    private visibilityTokenPatches = new Map<any, TokenPatch>()
    private originalParameters?: (...args: any[]) => any
    private wrappedParameters?: (...args: any[]) => any
    private destroyed = false

    constructor(private config: ConfigService, private app: AppService, private profiles: ProfilesService) {
        this.installProfileHook()
        for (const event of [(this.app as any).tabOpened$, (this.app as any).tabsChanged$, this.config.ready$]) {
            if (event?.subscribe) this.subscriptions.push(event.subscribe(() => this.observeTabs()))
        }
        this.observeTabs()
    }

    private installProfileHook() {
        const profiles: any = this.profiles
        if (typeof profiles?.newTabParametersForProfile !== 'function') return
        const original = profiles.newTabParametersForProfile
        const service = this
        const wrapped = async function (this: any, profile: any, ...args: any[]) {
            const params = await original.call(this, profile, ...args)
            if (service.destroyed || profile?.type !== 'split-layout' || typeof profile.id !== 'string' || !profile.id) return params
            const recovered = params?.inputs?._recoveredState
            if (!recovered || recovered.type !== 'app:split-tab') return params
            // The provider returns the saved config token by reference. Copy it before
            // annotating so neither the marker nor Tabby's recovery mutates that profile.
            const token = JSON.parse(JSON.stringify(recovered))
            token[LAYOUT_SCOPE_MARKER] = profile.id
            for (const leaf of layoutLeafTokens(token)) {
                const child = leaf.token.profile
                if (child?.type === 'ssh' && typeof child.id === 'string' && child.id) {
                    child[PANE_SCOPE_MARKER] = layoutPaneId(profile.id, leaf.path, child.id)
                }
            }
            return { ...params, inputs: { ...params.inputs, _recoveredState: token } }
        }
        this.originalParameters = original
        this.wrappedParameters = wrapped
        profiles.newTabParametersForProfile = wrapped
    }

    private marker(tab: any): string | undefined {
        const token = tab?._recoveredState
        if (token?.type !== 'app:split-tab') return undefined
        const value = token[LAYOUT_SCOPE_MARKER]
        return typeof value === 'string' && value ? value : undefined
    }

    private observeTabs() {
        if (this.destroyed) return
        const seen = new Set<any>()
        const visit = (tab: any) => {
            if (!tab || seen.has(tab)) return
            seen.add(tab)
            this.preserveRecoveryMarker(tab)
            const layoutId = this.marker(tab)
            if (layoutId) this.rememberLegacyPanes(tab, layoutId)
            this.preserveVisibilityMarker(tab)
            const children = typeof tab.getAllTabs === 'function' ? tab.getAllTabs() : []
            for (const child of Array.isArray(children) ? children : []) visit(child)
        }
        for (const tab of (this.app as any).tabs || []) visit(tab)
    }

    private preserveRecoveryMarker(tab: any) {
        if (!this.marker(tab) || typeof tab.getRecoveryToken !== 'function' || this.tokenPatches.has(tab)) return
        const original = tab.getRecoveryToken
        const service = this
        const wrapped = async function (this: any, ...args: any[]) {
            const token = await original.apply(this, args)
            const id = service.marker(this)
            if (!service.destroyed && id && token?.type === 'app:split-tab') {
                return service.preservePaneRecoveryMarkers(this, { ...token, [LAYOUT_SCOPE_MARKER]: id }, id)
            }
            return token
        }
        const patch: TokenPatch = { original, wrapped, hadOwnMethod: Object.prototype.hasOwnProperty.call(tab, 'getRecoveryToken') }
        this.tokenPatches.set(tab, patch)
        tab.getRecoveryToken = wrapped
        if (tab.destroyed$?.subscribe) patch.destroyed = tab.destroyed$.subscribe(() => this.releaseTab(tab))
    }

    private releaseTab(tab: any) {
        const patch = this.tokenPatches.get(tab)
        if (!patch) return
        if (tab.getRecoveryToken === patch.wrapped) {
            if (patch.hadOwnMethod) tab.getRecoveryToken = patch.original
            else delete tab.getRecoveryToken
        }
        patch.destroyed?.unsubscribe()
        this.tokenPatches.delete(tab)
    }

    private rememberPane(leaf: any, layoutId: string, targetId: string) {
        let targets = this.paneTargets.get(leaf)
        if (!targets) { targets = new Map(); this.paneTargets.set(leaf, targets) }
        targets.set(layoutId, targetId)
    }

    private paneMarker(profile: any): string | undefined {
        return this.privateProfileMarker(profile, PANE_SCOPE_MARKER)
    }

    private privateProfileMarker(profile: any, key: typeof PANE_SCOPE_MARKER | typeof INSTANCE_VISIBILITY_MARKER): string | undefined {
        // ConfigProxy exposes only declared defaults as properties. Its raw
        // getter preserves our one custom field without reading credentials.
        try {
            const direct = profile?.[key]
            if (typeof direct === 'string' && direct) return direct
            const raw = typeof profile?.__getValue === 'function' ? profile.__getValue(key) : undefined
            return typeof raw === 'string' && raw ? raw : undefined
        } catch { return undefined }
    }

    private visibilityInstance(tab: any): string | undefined {
        const remembered = this.visibilityInstances.get(tab)
        if (remembered) return remembered
        const value = this.privateProfileMarker(tab?.profile, INSTANCE_VISIBILITY_MARKER)
        if (value && /^pane-instance:[a-f0-9]{32}$/.test(value)) return value
        return undefined
    }

    private preserveVisibilityMarker(tab: any) {
        if (!tab || (!this.visibilityInstance(tab) && !this.paneMarker(tab.profile) && !this.paneTargets.has(tab)) ||
            typeof tab.getRecoveryToken !== 'function' || this.visibilityTokenPatches.has(tab)) return
        const original = tab.getRecoveryToken
        const service = this
        const wrapped = async function (this: any, ...args: any[]) {
            const token = await original.apply(this, args)
            const key = service.visibilityInstance(this)
            // Clone the returned profile; editing this.profile would also edit a
            // saved connection shared by other panes using the same profile.
            if (!service.destroyed && token?.profile) {
                const profile = { ...token.profile }
                if (args[0]?.includeState === true) {
                    if (key) profile[INSTANCE_VISIBILITY_MARKER] = key
                    const paneId = service.paneMarker(this.profile)
                    if (paneId) profile[PANE_SCOPE_MARKER] = paneId
                } else {
                    // Tabby's duplicate action uses recovery without includeState.
                    // A new pane must not inherit another pane's visibility key.
                    delete profile[INSTANCE_VISIBILITY_MARKER]
                    delete profile[PANE_SCOPE_MARKER]
                    // Do not leave a copied ConfigProxy getter pointing at the
                    // old raw marker after the visible property was removed.
                    delete profile.__getValue
                    // A fresh identity also marks an untouched duplicate as a
                    // new pane after restart, rather than an old layout slot.
                    profile[INSTANCE_VISIBILITY_MARKER] = `pane-instance:${randomBytes(16).toString('hex')}`
                }
                return { ...token, profile }
            }
            return token
        }
        const patch: TokenPatch = { original, wrapped, hadOwnMethod: Object.prototype.hasOwnProperty.call(tab, 'getRecoveryToken') }
        this.visibilityTokenPatches.set(tab, patch)
        tab.getRecoveryToken = wrapped
        if (tab.destroyed$?.subscribe) patch.destroyed = tab.destroyed$.subscribe(() => this.releaseVisibilityTab(tab))
    }

    private releaseVisibilityTab(tab: any) {
        const patch = this.visibilityTokenPatches.get(tab)
        if (!patch) return
        if (tab.getRecoveryToken === patch.wrapped) {
            if (patch.hadOwnMethod) tab.getRecoveryToken = patch.original
            else delete tab.getRecoveryToken
        }
        patch.destroyed?.unsubscribe()
        this.visibilityTokenPatches.delete(tab)
    }

    /** A layout occurrence is stable across reopen; other panes own recovery-only IDs. */
    visibilityKey(session: any): string | undefined {
        if (this.destroyed || !session || session.open === false) return undefined
        const context = this.contextForSession(session)
        const available = new Set(getLayoutPaneTargets(this.config.store?.profiles || [], false).map(target => target.id))
        const layoutKey = context.profileIds.find(id => available.has(id))
        if (layoutKey) return layoutKey
        const leaf = findSessionTab((this.app as any).tabs || [], session)
        return this.visibilityInstance(leaf || session)
    }

    isPaneVisible(session: any): boolean {
        const key = this.visibilityKey(session)
        return !key || this.config.store?.plugin?.serverStats?.paneVisibility?.[key] !== false
    }

    private panePreferenceKey(session: any): string | undefined {
        if (this.destroyed || !session || session.open === false) return undefined
        let key = this.visibilityKey(session)
        if (!key) {
            const leaf = findSessionTab((this.app as any).tabs || [], session)
            key = `pane-instance:${randomBytes(16).toString('hex')}`
            this.visibilityInstances.set(leaf || session, key)
            this.preserveVisibilityMarker(leaf)
        }
        return key
    }

    private savePanePreference(session: any, map: 'paneVisibility' | 'paneGroupModes', value: boolean | PaneGroupMode) {
        const key = this.panePreferenceKey(session)
        if (!key) return
        if (!this.config.store.plugin) this.config.store.plugin = {}
        if (!this.config.store.plugin.serverStats) this.config.store.plugin.serverStats = {}
        const stats = this.config.store.plugin.serverStats
        const previous = stats[map]
        stats[map] = { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), [key]: value }
        this.config.save?.()
    }

    setPaneVisible(session: any, visible: boolean) {
        this.savePanePreference(session, 'paneVisibility', Boolean(visible))
    }

    getPaneGroupMode(session: any): PaneGroupMode | undefined {
        const key = this.visibilityKey(session)
        const value = key && this.config.store?.plugin?.serverStats?.paneGroupModes?.[key]
        return value === 'overview' || value === 'carousel' || value === 'static' ? value : undefined
    }

    setPaneGroupMode(session: any, mode: PaneGroupMode) {
        if (mode !== 'overview' && mode !== 'carousel' && mode !== 'static') return
        this.savePanePreference(session, 'paneGroupModes', mode)
    }

    /** Upgrade already restored layouts without guessing from a focused or sibling pane. */
    private rememberLegacyPanes(ancestor: any, layoutId: string) {
        if (this.legacyPanesObserved.has(ancestor)) return
        const leaves = typeof ancestor.getAllTabs === 'function' ? ancestor.getAllTabs() : []
        const tokens = layoutLeafTokens(ancestor._recoveredState)
        // Tabby flattens redundant split containers during restoration. Flat leaf
        // order survives that normalization; validate the complete sequence first.
        if (!Array.isArray(leaves) || !leaves.length || leaves.length !== tokens.length) return
        if (!leaves.every((leaf, index) => {
            const saved = tokens[index].token.profile
            return typeof saved?.id === 'string' && saved.id && saved.id === leaf?.profile?.id && saved.type === leaf.profile.type
        })) return
        this.legacyPanesObserved.add(ancestor)
        leaves.forEach((leaf, index) => {
            if (leaf.profile.type !== 'ssh' || this.paneTargets.get(leaf)?.has(layoutId)) return
            const ownMarker = this.paneMarker(leaf.profile)
            if (!ownMarker && this.visibilityInstance(leaf)) return
            const marked = ownMarker || this.paneMarker(tokens[index].token.profile)
            this.rememberPane(leaf, layoutId, marked ||
                layoutPaneId(layoutId, tokens[index].path, leaf.profile.id))
        })
    }

    private paneTargetFor(leaf: any, ancestor: any, layoutId: string, available: LayoutPaneTarget[]): string | undefined {
        if (!leaf) return undefined
        const marked = this.paneMarker(leaf.profile)
        if (!marked && this.visibilityInstance(leaf)) return undefined
        if (!marked && !this.paneTargets.get(leaf)?.has(layoutId)) {
            this.rememberLegacyPanes(ancestor, layoutId)
        }
        const targetId = marked || this.paneTargets.get(leaf)?.get(layoutId)
        return available.find(target => target.id === targetId && target.layoutId === layoutId && target.profileId === leaf.profile?.id)?.id
    }

    private preservePaneRecoveryMarkers(ancestor: any, token: any, layoutId: string): any {
        const leaves = typeof ancestor.getAllTabs === 'function' ? ancestor.getAllTabs() : []
        const tokens = layoutLeafTokens(token)
        if (!Array.isArray(leaves) || leaves.length !== tokens.length) return token
        const available = getLayoutPaneTargets(this.config.store?.profiles || [], false)
        const replacements = new Map<any, any>()
        for (let index = 0; index < tokens.length; index++) {
            const node = tokens[index].token
            const leaf = leaves[index]
            if (node.profile?.id !== leaf?.profile?.id) return token
            const targetId = this.paneTargetFor(leaf, ancestor, layoutId, available)
            if (targetId) replacements.set(node, { ...node, profile: { ...node.profile, [PANE_SCOPE_MARKER]: targetId } })
        }
        const copy = (node: any): any => replacements.get(node) || (node?.type === 'app:split-tab' && Array.isArray(node.children) ?
            { ...node, children: node.children.map(copy) } : node)
        return copy(token)
    }

    contextForSession(session: any): ScopeContext {
        if (this.destroyed || !session || session.open === false) return { profileIds: [] }
        this.observeTabs()
        const leaf = findSessionTab((this.app as any).tabs || [], session)
        const profile = typeof leaf?.profile?.id === 'string' && leaf.profile.id ? leaf.profile : session.profile
        const ids = new Set(resolveProfileScopeIds(profile, this.config.store?.profiles || [], candidate =>
            (this.profiles as any).getConfigProxyForProfile?.(candidate) || candidate))
        const availablePanes = getLayoutPaneTargets(this.config.store?.profiles || [], false)
        // Parent links reflect the current layout. A pane moved out of a saved
        // layout loses that association; sibling profiles are never collected.
        const visited = new Set<any>()
        let ancestor = leaf?.parent
        while (ancestor && !visited.has(ancestor)) {
            visited.add(ancestor)
            this.preserveRecoveryMarker(ancestor)
            const id = this.marker(ancestor)
            if (id) {
                ids.add(id)
                const paneId = this.paneTargetFor(leaf, ancestor, id, availablePanes)
                if (paneId) ids.add(paneId)
            }
            ancestor = ancestor.parent
        }
        return { profileIds: [...ids] }
    }

    ngOnDestroy() {
        this.destroyed = true
        this.subscriptions.forEach(subscription => subscription.unsubscribe())
        this.subscriptions = []
        const profiles: any = this.profiles
        if (this.wrappedParameters && profiles?.newTabParametersForProfile === this.wrappedParameters) {
            profiles.newTabParametersForProfile = this.originalParameters
        }
        for (const tab of [...this.tokenPatches.keys()]) this.releaseTab(tab)
        for (const tab of [...this.visibilityTokenPatches.keys()]) this.releaseVisibilityTab(tab)
    }
}
