import type { CustomMetric, CustomMetricGroup, DisplayScope } from './metric-model'

export interface ScopeContext { profileIds: string[] }
export interface ScopedMetrics { customMetrics?: CustomMetric[]; metricGroups?: CustomMetricGroup[] }

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
