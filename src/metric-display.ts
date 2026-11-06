import type { CustomMetric, CustomMetricGroup } from './config'

export interface DisplayResult {
    id: string
    value: string
    status?: 'ok' | 'unavailable' | 'error' | 'pending'
}

// Only format complete numeric values. Shell error messages and arbitrary text
// must remain intact; callers keep the raw reading for thresholds and progress.
const numericText = /^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/
const networkRateFormat = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
    useGrouping: true,
})

/** True only for a complete, finite numeric display value (including grouped values). */
export function isNumericDisplayValue(value: string): boolean {
    return numericText.test(value.trim()) && Number.isFinite(Number(value.replace(/,/g, '')))
}

/** Convert a KiB/s reading to decimal MB/s with exactly three fractional digits. */
export function formatNetworkRate(value: string): string {
    if (!isNumericDisplayValue(value)) return value
    const amount = Number(value.replace(/,/g, '')) * (1024 / 1000000)
    if (!Number.isFinite(amount)) return value
    // Rounding a tiny negative value must not produce a confusing "-0.000".
    return networkRateFormat.format(Math.abs(amount) < 0.0005 ? 0 : amount)
}

export interface NumericRatio {
    numerator: string
    denominator: string
    suffix: string
}

/** Split capacity-style pairs into independent columns without changing precision. */
export function parseNumericRatio(value: string): NumericRatio | null {
    const match = /^\s*([^/\r\n]+?)\s*\/\s*([^/\s]+?)\s*([KMGTPE]?i?B|%)?\s*$/i.exec(value || '')
    if (!match) return null
    const numerator = match[1].trim()
    const denominator = match[2].trim()
    if (![numerator, denominator].every(isNumericDisplayValue)) return null
    return { numerator, denominator, suffix: match[3] || '' }
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
