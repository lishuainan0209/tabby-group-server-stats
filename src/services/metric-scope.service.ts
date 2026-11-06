import { Injectable, OnDestroy } from '@angular/core'
import { AppService, ConfigService, ProfilesService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { findSessionTab, ScopeContext } from '../display-scope'

/** A saved layout's origin, persisted in its recovery token, never inferred from titles. */
export const LAYOUT_SCOPE_MARKER = '__tabbyGroupServerStatsLayoutProfileId'

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
            if (!service.destroyed && id && token?.type === 'app:split-tab') return { ...token, [LAYOUT_SCOPE_MARKER]: id }
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

    contextForSession(session: any): ScopeContext {
        if (this.destroyed || !session || session.open === false) return { profileIds: [] }
        this.observeTabs()
        const leaf = findSessionTab((this.app as any).tabs || [], session)
        const ids = new Set<string>()
        const leafId = typeof leaf?.profile?.id === 'string' && leaf.profile.id ? leaf.profile.id : session.profile?.id
        if (typeof leafId === 'string' && leafId) ids.add(leafId)
        // Parent links reflect the current layout. A pane moved out of a saved
        // layout loses that association; sibling profiles are never collected.
        const visited = new Set<any>()
        let ancestor = leaf?.parent
        while (ancestor && !visited.has(ancestor)) {
            visited.add(ancestor)
            this.preserveRecoveryMarker(ancestor)
            const id = this.marker(ancestor)
            if (id) ids.add(id)
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
    }
}
