/** Shared severity colors for shipped metrics and laboratory presets. */
export const METRIC_COLORS = { green: '#00ff00', orange: '#ffa500', red: '#ff0000' } as const

export function usageColorRules(warning: number, critical: number) {
    return [
        { operator: '>' as const, value: String(critical), color: METRIC_COLORS.red },
        { operator: '>' as const, value: String(warning), color: METRIC_COLORS.orange }
    ]
}

export function capacityColorRules(total = false) {
    return [
        { operator: '<' as const, value: total ? '50' : '20', color: METRIC_COLORS.red },
        { operator: '<=' as const, value: total ? '100' : '40', color: METRIC_COLORS.orange }
    ]
}
