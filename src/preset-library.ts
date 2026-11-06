import { CustomMetric, CustomMetricGroup, DisplayScope, shellQuote } from './metric-model'
import { createCpuSampleCommand } from './builtin-metrics'
import { METRIC_COLORS, capacityColorRules, usageColorRules } from './metric-colors'

export interface MetricPreset {
    id: string
    kind: 'metric' | 'group'
    label: string
    description?: string
    labels?: { en: string; zh: string }
    descriptions?: { en: string; zh: string }
    metric?: CustomMetric
    group?: CustomMetricGroup
    /** Portable bindings contain saved profile names, never machine-local IDs. */
    profileNames?: string[]
    source?: { name: string; url?: string; license?: string }
    audience?: 'author-lab'
}
export interface PresetProfile { id?: string; name?: string }
export interface InstantiatedPreset {
    customMetrics: CustomMetric[]
    metricGroups: CustomMetricGroup[]
    missingProfileNames: string[]
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const localSource = { name: 'lishuainan0209 / Tabby Group Server Stats', url: 'https://github.com/lishuainan0209/tabby-group-server-stats', license: 'MIT' }

/** A failed query stays failed; empty or zero-capacity output is never shown as 0%. */
export function createGpuCommand(index?: number, detail = false): string {
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new Error('Invalid GPU index')
    const selected = index === undefined ? '' : ` --id=${index}`
    const result = detail ? 'printf "%.1f/%.1f GiB\\n",free/1024,total/1024' : 'printf "%d\\n",used*100/total'
    const query = '--query-gpu=memory.used,memory.total,memory.free --format=csv,noheader,nounits'
    const aggregate = `awk -F, 'NF { if(NF!=3) {bad=1; next} for(i=1;i<=3;i++) {gsub(/^[[:space:]]+|[[:space:]]+$/,"",$i); if($i !~ /^[0-9]+([.][0-9]+)?$/) bad=1} if($2<=0) bad=1; used+=$1; total+=$2; free+=$3; count++ } END {if(bad || !count || total<=0) exit 1; ${result}}'`
    if (index !== undefined) return `data=$(nvidia-smi${selected} ${query} 2>/dev/null) || exit 1; printf '%s\\n' "$data" | ${aggregate}`
    // One broken device can make the all-device query fail. Keep the fast path,
    // then collect only individually readable, valid devices from the eight slots.
    return `tabby_gpu_value() { printf '%s\\n' "$1" | ${aggregate}; }; if gpu_data=$(nvidia-smi ${query} 2>/dev/null) && tabby_gpu_value "$gpu_data"; then :; else gpu_data=$(for gpu_index in 0 1 2 3 4 5 6 7; do gpu_row=$(nvidia-smi --id="$gpu_index" ${query} 2>/dev/null) || continue; tabby_gpu_value "$gpu_row" >/dev/null && printf '%s\\n' "$gpu_row"; done); tabby_gpu_value "$gpu_data"; fi`
}

export function createGpuCheckCommand(index?: number): string {
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new Error('Invalid GPU index')
    const selected = index === undefined ? '' : ` --id=${index}`
    const match = index === undefined ? '$0 ~ /^[0-9]+$/' : `$0 == "${index}"`
    const validate = `awk '{gsub(/^[[:space:]]+|[[:space:]]+$/,"",$0); if(${match}) found=1} END {exit !found}'`
    if (index !== undefined) return `data=$(nvidia-smi${selected} --query-gpu=index --format=csv,noheader,nounits 2>/dev/null) || exit 1; printf '%s\\n' "$data" | ${validate}`
    return `tabby_gpu_exists() { gpu_data=$(nvidia-smi "$@" --query-gpu=index --format=csv,noheader,nounits 2>/dev/null) || return 1; printf '%s\\n' "$gpu_data" | ${validate}; }; tabby_gpu_exists || (for gpu_index in 0 1 2 3 4 5 6 7; do tabby_gpu_exists --id="$gpu_index" && exit 0; done; exit 1)`
}

function gpuMetric(index?: number): CustomMetric {
    return { id: index === undefined ? 'gpu-main' : `gpu-${index}`, label: index === undefined ? 'GPU' : `GPU ${index}`,
        type: 'text', icon: 'stats-vram', suffix: '%', color: METRIC_COLORS.green, interval: 20, timeout: 60,
        command: createGpuCommand(index), detailCommand: createGpuCommand(index, true),
        checkCommand: createGpuCheckCommand(index), checkMode: 'exitCode', checkExpected: '0', unavailableText: '无GPU',
        showWhenUnavailable: index === undefined, visibleWhenUnavailable: index === undefined,
        colorRules: usageColorRules(50, 80) }
}

export function createGpuGroupPreset(): MetricPreset {
    return { id: 'gpu-memory-group', kind: 'group', label: 'GPU 显存', labels: { en: 'GPU memory', zh: 'GPU 显存' },
        description: '显存使用率；悬停显示剩余/总显存。自动隐藏不存在的 GPU 0–7。',
        descriptions: { en: 'VRAM use percentage; hover for free/total GiB. Missing GPUs 0–7 are hidden.', zh: '显存使用率；悬停显示剩余/总显存（GiB）。自动隐藏不存在的 GPU 0–7。' },
        source: localSource,
        group: { id: 'gpu-memory-group', label: 'GPU 显存', mode: 'overview', layout: 'vertical', interval: 3,
            displayScope: { mode: 'all', profileIds: [] }, main: gpuMetric(), children: Array.from({ length: 8 }, (_, index) => gpuMetric(index)) } }
}

// Emit only from END after validating the whole df result. An early awk exit
// still runs END, so printing there without a failure guard can turn errors into 0.
const diskValues = `awk 'NR==2 {if(NF<6 || $2 !~ /^[0-9]+$/ || $4 !~ /^[0-9]+$/ || $2<=0 || $4>$2) bad=1; else {total=$2; available=$4; found=1}} NR>2 && NF {bad=1} END {if(bad || !found) exit 1; printf "%.0f %.0f\\n",total,available}'`

/** Sum readable mounted filesystems once, even when bind mounts use different names. */
export function createDiskTotalCommand(mountPaths: string[], detail = false): string {
    const paths = ['/', ...new Set(mountPaths.filter(path => typeof path === 'string' && path.startsWith('/') && path !== '/'))]
    const result = detail ? 'printf "%.1f/%.1f GiB\\n",available/1048576,total/1048576' : 'printf "%.0f\\n",int(available/1048576)'
    return `_disk_rows=$(
for _disk_path in ${paths.map(shellQuote).join(' ')}; do
    if [ "$_disk_path" != / ]; then mountpoint -q -- "$_disk_path" 2>/dev/null || continue; fi
    _disk_device=$(stat -Lc '%d' -- "$_disk_path" 2>/dev/null) || continue
    case "$_disk_device" in ''|*[!0-9]*) continue;; esac
    _disk_data=$(df -Pk -- "$_disk_path" 2>/dev/null) || continue
    _disk_values=$(printf '%s\\n' "$_disk_data" | ${diskValues}) || continue
    _disk_current=$(stat -Lc '%d' -- "$_disk_path" 2>/dev/null) || continue
    [ "$_disk_device" = "$_disk_current" ] || continue
    if [ "$_disk_path" != / ]; then mountpoint -q -- "$_disk_path" 2>/dev/null || continue; fi
    printf '%s %s\\n' "$_disk_device" "$_disk_values"
done
)
printf '%s\\n' "$_disk_rows" | awk 'NF {if(NF!=3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/ || $2<=0 || $3>$2) {bad=1; next} if(!seen[$1]++) {total+=$2; available+=$3; count++}} END {if(bad || !count || total<=0) exit 1; ${result}}'`
}

/** mountpoint prevents df /missing/path from silently reporting a parent filesystem. */
function diskMetric(mountPath: string, system: boolean, index: number): CustomMetric {
    const quoted = shellQuote(mountPath)
    const query = `data=$(df -Pk -- ${quoted} 2>/dev/null) || exit 1; values=$(printf '%s\\n' "$data" | ${diskValues}) || exit 1; printf '%s\\n' "$values" | awk`
    return { id: system ? 'disk-root' : `disk-mount-${index}`, label: system ? '系统盘' : mountPath,
        type: 'text', icon: system ? 'stats-system-disk' : 'stats-data-disk', color: METRIC_COLORS.green, suffix: ' GiB', interval: 20, timeout: 60,
        checkCommand: system ? `test -d ${quoted} && df -Pk -- ${quoted} >/dev/null 2>&1` : `mountpoint -q -- ${quoted}`,
        checkMode: 'exitCode', checkExpected: '0', unavailableText: '未挂载', showWhenUnavailable: true, visibleWhenUnavailable: true,
        command: `${query} '{printf "%.0f\\n",int($2/1048576)}'`,
        detailCommand: `${query} '{printf "%.1f/%.1f GiB\\n",$2/1048576,$1/1048576}'`,
        colorRules: capacityColorRules() }
}

export function createDiskGroupPreset(name: string, mountPaths: string[], profileNames: string[], template?: Partial<CustomMetricGroup>): MetricPreset {
    const labOnly = /^P[0-4](?:容器)?磁盘$/.test(name)
    const noticeZh = labOnly ? '作者实验室自用，其他人请勿下载使用。' : ''
    const noticeEn = labOnly ? "For the author's laboratory only. Other users: please do not download or use this preset. " : ''
    const paths = [...new Set(mountPaths.filter(path => typeof path === 'string' && path.startsWith('/') && path !== '/'))]
    const main: CustomMetric = { ...diskMetric('/', true, 0), id: 'disk-total', label: '磁盘总余量', icon: 'stats-disk-space',
        // The aggregate validates every candidate itself; no valid rows is an
        // execution error, while a legitimately full readable filesystem is 0.
        checkCommand: '', command: createDiskTotalCommand(paths), detailCommand: createDiskTotalCommand(paths, true),
        colorRules: capacityColorRules(true) }
    const group: CustomMetricGroup = { ...clone(template || {}), id: 'disk-group', label: name, mode: template?.mode || 'overview',
        layout: template?.layout || 'vertical', interval: template?.interval || 3,
        main, children: [diskMetric('/', true, 0), ...paths.map((path, index) => diskMetric(path, false, index))],
        displayScope: { mode: 'selected', profileIds: [] } }
    return { id: `disks-${name}`, kind: 'group', label: name, group, source: localSource, audience: labOnly ? 'author-lab' : undefined,
        description: noticeZh + '主标签汇总有效文件系统的总余量；子标签依次为系统盘和数据盘。悬停显示剩余/总容量，未挂载的磁盘保留提醒。',
        descriptions: { en: noticeEn + 'Total free capacity across valid unique filesystems; children show the system disk first, then data mounts. Hover for free/total capacity; missing mounts remain visible.', zh: noticeZh + '主标签汇总有效文件系统的总余量；子标签依次为系统盘和数据盘。悬停显示剩余/总容量，未挂载的磁盘保留提醒。' },
        profileNames: [...new Set(profileNames.map(profile => profile.trim()).filter(Boolean))] }
}

function validMetric(value: any): value is CustomMetric {
    return Boolean(value && typeof value === 'object' && typeof value.command === 'string' && (value.type === undefined || value.type === 'text' || value.type === 'progress'))
}
function normalizeMetric(value: any, id: string): CustomMetric {
    if (!validMetric(value)) throw new Error('Invalid preset metric')
    return { ...clone(value), id: typeof value.id === 'string' ? value.id : id, type: value.type || 'text' }
}

/** Accept the upstream flat metric array as well as this fork's portable group format. */
export function normalizePresetLibrary(input: unknown): MetricPreset[] {
    const entries = Array.isArray(input) ? input : (input as any)?.presets
    if (!Array.isArray(entries) || entries.length > 1000) throw new Error('Invalid preset library')
    return entries.map((entry, index) => {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid preset entry')
        if (!entry.kind && validMetric(entry)) {
            return { id: `legacy-${index}`, kind: 'metric', label: entry.label || `Metric ${index + 1}`, metric: normalizeMetric(entry, `legacy-${index}`) }
        }
        const result: MetricPreset = { ...clone(entry), id: typeof entry.id === 'string' ? entry.id : `preset-${index}`, label: entry.label || `Preset ${index + 1}` }
        if (result.kind === 'metric') result.metric = normalizeMetric(entry.metric, `${result.id}-metric`)
        else if (result.kind === 'group' && entry.group && Array.isArray(entry.group.children)) {
            result.group = { ...clone(entry.group), id: entry.group.id || result.id,
                mode: ['overview', 'carousel', 'static'].includes(entry.group.mode) ? entry.group.mode : 'overview',
                layout: entry.group.layout === 'horizontal' ? 'horizontal' : 'vertical',
                main: normalizeMetric(entry.group.main, `${result.id}-main`),
                children: entry.group.children.map((metric: any, child: number) => normalizeMetric(metric, `${result.id}-${child}`)) }
        } else throw new Error('Invalid preset kind')
        if (result.profileNames !== undefined) {
            if (!Array.isArray(result.profileNames) || result.profileNames.some(name => typeof name !== 'string')) throw new Error('Invalid preset profile names')
            result.profileNames = [...new Set(result.profileNames.map(name => name.trim()).filter(Boolean))]
        }
        return result
    })
}

/** Loaded from the shipped package, without a network request or moving upstream URL. */
export function getBundledPresets(): MetricPreset[] {
    return normalizePresetLibrary(require('../presets.json'))
}

let importSequence = 0
export function instantiatePreset(preset: MetricPreset, profiles: PresetProfile[], makeId: () => string = () => `preset-${Date.now()}-${++importSequence}`): InstantiatedPreset {
    const entry = normalizePresetLibrary([preset])[0]
    const missingProfileNames: string[] = []
    let scope: DisplayScope = { mode: 'all', profileIds: [] }
    const originalScope = entry.kind === 'group' ? entry.group?.displayScope : entry.metric?.displayScope
    const requestedNames = entry.profileNames ?? (originalScope?.mode === 'selected' ? Object.values(originalScope.profileNames || {}) : undefined)
    if (requestedNames !== undefined) {
        scope = { mode: 'selected', profileIds: [], profileNames: {} }
        for (const name of [...new Set(requestedNames)]) {
            const matches = profiles.filter(profile => profile.id && profile.name?.trim() === name.trim())
            if (matches.length !== 1) { missingProfileNames.push(name); continue }
            scope.profileIds.push(matches[0].id!)
            scope.profileNames![matches[0].id!] = matches[0].name!
        }
    }
    const metric = (value: CustomMetric): CustomMetric => ({ ...clone(value), id: makeId(), displayScope: undefined })
    if (entry.kind === 'metric') return { customMetrics: [{ ...metric(entry.metric!), displayScope: scope }], metricGroups: [], missingProfileNames }
    const group = entry.group!
    return { customMetrics: [], metricGroups: [{ ...clone(group), id: makeId(), displayScope: scope,
        main: metric(group.main), children: group.children.map(metric) }], missingProfileNames }
}

/** Strip local binding IDs; shared presets contain commands plus portable profile names. */
export function exportPresetLibrary(presets: MetricPreset[]): string {
    const result = normalizePresetLibrary(presets).map(entry => {
        const target = entry.kind === 'group' ? entry.group! : entry.metric!
        if (target.displayScope?.mode === 'selected') entry.profileNames = entry.profileNames ?? Object.values(target.displayScope.profileNames || {})
        target.displayScope = { mode: entry.profileNames === undefined ? 'all' : 'selected', profileIds: [] }
        if (entry.group) for (const metric of [entry.group.main, ...entry.group.children]) delete metric.displayScope
        return entry
    })
    return JSON.stringify(result, null, 2) + '\n'
}

/** Kept exported for offline library maintenance without temporary /tmp sample files. */
export const SAFE_IO_WAIT_COMMAND = createCpuSampleCommand('iowait')
export const SAFE_STEAL_COMMAND = createCpuSampleCommand('steal')
