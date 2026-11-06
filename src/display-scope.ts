import type { CustomMetric, CustomMetricGroup, DisplayScope } from './metric-model'

export interface ScopeContext { profileIds: string[] }
export interface ScopedMetrics { customMetrics?: CustomMetric[]; metricGroups?: CustomMetricGroup[] }

/** Connection identity only: never inspect passwords, keys, titles or sibling panes. */
function sshEndpoint(profile: any): string | null {
    if (profile?.type !== 'ssh') return null
    const options = profile.options
    if (!options || typeof options.host !== 'string' || !options.host.trim() ||
        typeof options.user !== 'string' || !options.user.trim()) return null
    const port = (value: any, fallback?: number): number | null => {
        if (value == null || value === '') return fallback ?? null
        if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null
        const number = Number(value)
        return Number.isInteger(number) && number > 0 && number <= 65535 ? number : null
    }
    const sshPort = port(options.port, 22)
    if (sshPort === null) return null
    const optional = (value: any): string | null => value == null ? '' : typeof value === 'string' ? value.trim() : null
    const jump = optional(options.jumpHost), command = optional(options.proxyCommand)
    const socks = optional(options.socksProxyHost), http = optional(options.httpProxyHost)
    if ([jump, command, socks, http].includes(null)) return null
    const socksPort = socks ? port(options.socksProxyPort) : 0
    const httpPort = http ? port(options.httpProxyPort) : 0
    if (socksPort === null || httpPort === null) return null
    return JSON.stringify([options.host.trim().toLowerCase(), sshPort, options.user,
        jump, command, socks!.toLowerCase(), socksPort, http!.toLowerCase(), httpPort])
}

/** Old saved layouts can retain a deleted copy of an otherwise current SSH profile. */
export function resolveProfileScopeIds(profile: any, availableProfiles: any[], effectiveProfile: (profile: any) => any = value => value): string[] {
    const id = typeof profile?.id === 'string' && profile.id ? profile.id : undefined
    const ids = id ? [id] : []
    const profiles = availableProfiles || []
    // An existing ID is authoritative, even if other profiles share its endpoint.
    // Unidentified quick connections must not silently inherit a saved scope.
    if (!id || profiles.some(candidate => candidate?.id === id)) return ids
    const endpoint = sshEndpoint(profile)
    if (!endpoint) return ids
    const matches = profiles.filter(candidate => {
        if (candidate?.type !== 'ssh' || typeof candidate.id !== 'string' || !candidate.id) return false
        try { return sshEndpoint(effectiveProfile(candidate)) === endpoint } catch { return false }
    })
    // Ambiguous accounts/routes remain unmatched instead of combining scopes.
    return matches.length === 1 ? [...ids, matches[0].id] : ids
}

export function matchesScope(scope: DisplayScope | undefined, context: ScopeContext, availableProfiles: any[]): boolean {
    if (!scope || scope.mode === 'all') return true
    if (scope.mode !== 'selected' || !Array.isArray(scope.profileIds)) return false
    const available = new Set((availableProfiles || []).map(profile => profile?.id).filter(Boolean))
    return scope.profileIds.some(id => available.has(id) && context.profileIds.includes(id))
}

export function filterScopedMetrics(config: ScopedMetrics, context: ScopeContext, profiles: any[]): Required<ScopedMetrics> {
    return {
        customMetrics: (config.customMetrics || []).filter(metric => metric.enabled !== false && matchesScope(metric.displayScope, context, profiles)),
        // A group is scoped as one unit. Its main/children inherit that scope.
        metricGroups: (config.metricGroups || []).filter(group => group.enabled !== false && matchesScope(group.displayScope, context, profiles)),
    }
}

/** Find the leaf that owns a session; never collect sibling profiles or focusedTab from another leaf. */
export function findSessionTab(tabs: any[], session: any): any | null {
    if (!session) return null
    const visited = new Set<any>()
    const visit = (tab: any): any => {
        if (!tab || visited.has(tab)) return null
        visited.add(tab)
        if (tab.session === session) return tab
        const children = typeof tab.getAllTabs === 'function' ? tab.getAllTabs() : []
        for (const child of Array.isArray(children) ? children : []) {
            const found = visit(child)
            if (found) return found
        }
        return null
    }
    for (const tab of tabs || []) {
        const found = visit(tab)
        if (found) return found
    }
    return null
}
