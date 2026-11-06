import type { CustomMetric, CustomMetricGroup } from './config'

export interface DisplayResult {
    id: string
    value: string
    status?: 'ok' | 'unavailable' | 'error' | 'pending'
}

/** Parse the built-in network protocol without translating numbers or interface names. */
export function parseNetworkDetail(value: string): { label: string; amount: string; interfaces: string } | null {
    const match = /^(Received|Sent|Combined) total: ([0-9]+(?:\.[0-9]+)?) GiB \(since interface reset; ([^)\r\n]+)\)$/.exec(value || '')
    return match ? { label: `${match[1]} total`, amount: match[2], interfaces: match[3] } : null
}

export function metricStatus(result?: DisplayResult): string {
    return result?.status || (!result || result.value === '-' ? 'pending' : result.value.startsWith('Err:') ? 'error' : 'ok')
}

/** Shared by single labels, static groups and expanded popups. */
export function metricIsVisible(metric: CustomMetric | undefined, results: DisplayResult[]): boolean {
    return !!metric && metric.enabled !== false && (metric.visibleWhenUnavailable !== false ||
        metricStatus(results.find(result => result.id === metric.id)) !== 'unavailable')
}

export function visibleGroupMetrics(group: CustomMetricGroup, results: DisplayResult[]): CustomMetric[] {
    if (group.enabled === false) return []
    return [group.main, ...(group.children || [])].filter(metric => metricIsVisible(metric, results))
}

// The carousel-specific opt-out remains independent from visibility elsewhere.
export function carouselChildren(group: CustomMetricGroup, results: DisplayResult[]): CustomMetric[] {
    if (group.enabled === false) return []
    return (group.children || []).filter(metric => metricIsVisible(metric, results) &&
        (metric.showWhenUnavailable !== false || metricStatus(results.find(result => result.id === metric.id)) !== 'unavailable'))
}

export function nextCarouselId(group: CustomMetricGroup, results: DisplayResult[], currentId?: string): string | undefined {
    const eligible = new Set(carouselChildren(group, results).map(metric => metric.id))
    const children = group.children || []
    const current = children.findIndex(metric => metric.id === currentId)
    for (let step = 1; step <= children.length; step++) {
        const metric = children[(current + step) % children.length]
        if (eligible.has(metric.id)) return metric.id
    }
    return undefined
}
