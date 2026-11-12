/** Shared metric configuration and command protocol. No Angular runtime required. */
export type ConditionOperator = '>=' | '>' | '<=' | '<' | '==' | '!=' | 'contains' | 'not_contains' | 'starts_with' | 'regex'

export interface ColorCondition {
    operator: ConditionOperator
    value: string
    color: string
}

/** Explicit selected-empty is intentionally different from global/legacy scope. */
export interface DisplayScope {
    mode: 'all' | 'selected'
    profileIds: string[]
    profileNames?: Record<string, string>
    /** Explicit per-layout pane opt-outs override a selected connection/layout. */
    excludedProfileIds?: string[]
}

export interface CustomMetric {
    id: string
    /** Omission preserves enabled legacy definitions. Disabled commands never run. */
    enabled?: boolean
    label?: string
    command: string
    /** Decode the disk I/O value protocol; color thresholds then use reference-bandwidth percent. */
    valueFormat?: 'disk-io-rate'
    type: 'progress' | 'text'
    icon?: string
    color?: string
    suffix?: string
    maxValue?: number
    interval?: number
    timeout?: number
    colorRules?: ColorCondition[]
    checkCommand?: string
    checkMode?: 'output' | 'exitCode'
    checkExpected?: string
    unavailableText?: string
    detailCommand?: string
    /** False starts hidden and retains the last check decision throughout refreshes. */
    visibleWhenUnavailable?: boolean
    /** Only carousel filtering uses this flag. Omission preserves visible failure notices. */
    showWhenUnavailable?: boolean
    displayScope?: DisplayScope
}

export interface CustomMetricGroup {
    id: string
    enabled?: boolean
    label?: string
    mode: 'overview' | 'carousel' | 'static'
    layout: 'horizontal' | 'vertical'
    interval?: number
    emptyText?: string
    main: CustomMetric
    children: CustomMetric[]
    displayScope?: DisplayScope
}

export type MetricStatus = 'ok' | 'unavailable' | 'error' | 'pending'
export interface MetricResult { id: string; value: string; status: MetricStatus }

export function allMetrics(config: { customMetrics?: CustomMetric[]; metricGroups?: CustomMetricGroup[] }): CustomMetric[] {
    const result = [...(config.customMetrics || [])]
    for (const group of config.metricGroups || []) {
        if (group.enabled === false) continue
        if (group.main) result.push(group.main)
        result.push(...(group.children || []))
    }
    // IDs identify cached values; duplicated imported IDs must not run twice.
    const seen = new Set<string>()
    return result.filter(metric => {
        if (!metric || metric.enabled === false || typeof metric.id !== 'string' || seen.has(metric.id)) return false
        seen.add(metric.id)
        return true
    })
}

export function metricTimeout(metric: CustomMetric): number {
    return Number.isFinite(metric.timeout) && metric.timeout! > 0 ? Math.max(1, metric.timeout!) : 30
}

export function shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\"'\"'") + "'"
}

/** Scripts are quoted as data. Each subshell writes exactly one bounded result line. */
export function buildMetricCommand(metric: CustomMetric, token: string, kind: 'value' | 'detail' = 'value'): string {
    if (!/^[a-zA-Z0-9_]+$/.test(token)) throw new Error('Invalid metric protocol token')
    const timeout = metricTimeout(metric)
    const run = (command: string) => `if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=2s ${timeout}s /bin/sh -c ${shellQuote(command)}
elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout --kill-after=2s ${timeout}s /bin/sh -c ${shellQuote(command)}
else
    # Kill the whole process group, including children of a timed-out script.
    setsid /bin/sh -c ${shellQuote(command)} &
    _child=$!
    (sleep ${timeout}; kill -TERM "-$_child" 2>/dev/null; sleep 2; kill -KILL "-$_child" 2>/dev/null) >/dev/null 2>&1 &
    _watchdog=$!
    wait "$_child"
    _result=$?
    kill -KILL "-$_child" 2>/dev/null
    kill "$_watchdog" 2>/dev/null
    wait "$_watchdog" 2>/dev/null
    if [ "$_result" -eq 143 ] || [ "$_result" -eq 137 ]; then exit 124; fi
    exit "$_result"
fi`
    const check = metric.checkCommand?.trim() ? `
_check_out=$(
${run(metric.checkCommand)}
)
_check_code=$?
if [ "$_check_code" -eq 124 ] || [ "$_check_code" -eq 137 ]; then
    printf 'TABBY-METRIC-RESULT:${token}:error:Err: Check timeout\\n'
    exit 0
fi
${metric.checkMode === 'output' ? `_check_value=$(printf '%s' "$_check_out" | awk 'BEGIN { value="" } { if (NR>1) value=value "\\n"; value=value $0 } END { sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); printf "%s", value }')
if [ "$_check_code" -ne 0 ] || [ "$_check_value" != ${shellQuote((metric.checkExpected ?? '').trim())} ]; then` : `if [ "$_check_code" != ${shellQuote((metric.checkExpected ?? '0').trim())} ]; then`}
    printf 'TABBY-METRIC-RESULT:${token}:unavailable:\\n'
    exit 0
fi
` : ''
    return `(
if ! command -v timeout >/dev/null 2>&1 && ! command -v gtimeout >/dev/null 2>&1 && ! command -v setsid >/dev/null 2>&1; then
    printf 'TABBY-METRIC-RESULT:${token}:error:Err: Install timeout or setsid\\n'
    exit 0
fi
${check}
_out=$(
${run(kind === 'detail' ? (metric.detailCommand || '') : metric.command)}
)
_code=$?
if [ "$_code" -eq 124 ] || [ "$_code" -eq 137 ]; then
    _status=error
    _val='Err: Timeout'
elif [ "$_code" -eq 0 ]; then
    _status=ok
    ${kind === 'detail' ? `_val=$(printf '%s' "$_out" | tr '\\r\\n' '  ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')` : `_val=$(printf '%s\\n' "$_out" | awk 'NF{p=$0} END{print p}' | tr '\\r\\n' '  ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$_val" ] && _val=0`}
else
    _status=error
    _val="Err: Exit $_code"
fi
# Stay below PIPE_BUF, so parallel results cannot interleave.
_val=$(printf '%s' "$_val" | cut -c 1-2000)
printf 'TABBY-METRIC-RESULT:${token}:%s:%s\\n' "$_status" "$_val"
) &`
}

export function parseMetricResults(buffer: string): Array<{ token: string; status: MetricStatus; value: string }> {
    const result: Array<{ token: string; status: MetricStatus; value: string }> = []
    // Only complete lines are accepted: SSH may split a UTF-8 value across chunks.
    const expression = /^TABBY-METRIC-RESULT:([a-zA-Z0-9_]+):(ok|unavailable|error):([^\r\n]*)\r?\n/gm
    let match: RegExpExecArray | null
    while ((match = expression.exec(buffer))) {
        result.push({ token: match[1], status: match[2] as MetricStatus, value: match[3].replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim() })
    }
    return result
}
