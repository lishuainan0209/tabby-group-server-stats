import { CustomMetric, CustomMetricGroup, DisplayScope, shellQuote } from './metric-model'
import { createCpuSampleCommand } from './builtin-metrics'
import { METRIC_COLORS, capacityColorRules, usageColorRules } from './metric-colors'
import { getLayoutPaneTargets, layoutPaneTargetName } from './display-scope'
import { createDiskIoCheckCommand, createDiskIoCommand } from './disk-io'

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
    /** Portable per-pane opt-outs, resolved before any selected scope can run. */
    excludedProfileNames?: string[]
    source?: { name: string; url?: string; license?: string }
    audience?: 'author-lab'
}
export interface PresetProfile { id?: string; name?: string; type?: string; options?: any }
export interface InstantiatedPreset {
    customMetrics: CustomMetric[]
    metricGroups: CustomMetricGroup[]
    missingProfileNames: string[]
}
export interface PresetOrigin { id: string; source: string; kind: 'metric' | 'group' }
type PresetTarget = (CustomMetric | CustomMetricGroup) & {
    presetOrigin?: PresetOrigin
    presetMetadata?: { source?: { url?: string } }
}

/** Source labels can be translated or renamed; only the URL is an identity. */
function canonicalPresetSource(url: unknown): string {
    if (typeof url !== 'string') return ''
    return url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^https?:\/\//i, 'https://')
}

function normalizeCommand(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
}

function normalizedDisplayCommand(value: unknown): string {
    // Compare the old/new unit labels in our known output formats only.
    // GiB in paths, executable names, checks or other text must stay distinct.
    return normalizeCommand(value)
        .replace(/(\bprintf\s+["']%\.1f\/%\.1f )GiB(?=(?: available)?\\n["'])/g, '$1GB')
        .replace(/(\bprintf\s+["'](?:Received|Sent|Combined) total: %\.3f )GiB(?= \(since interface reset; %s\)\\n["'])/g, '$1GB')
}

function metricDefinition(metric: CustomMetric): unknown[] {
    const check = normalizeCommand(metric.checkCommand)
    const mode = metric.checkMode === 'output' ? 'output' : 'exitCode'
    const suffix = metric.suffix?.trim() || (metric.type === 'progress' ? '%' : '')
    return [normalizedDisplayCommand(metric.command), normalizedDisplayCommand(metric.detailCommand),
        check, check ? mode : '', check ? (metric.checkExpected ?? (mode === 'output' ? '' : '0')).trim() : '',
        // GB is a display alias for the legacy GiB value; other units differ.
        suffix === 'GiB' ? 'GB' : suffix]
}

function definitionBody(item: CustomMetric | CustomMetricGroup, kind: 'metric' | 'group'): unknown {
    if (kind === 'metric') return metricDefinition(item as CustomMetric)
    const group = item as CustomMetricGroup
    return [metricDefinition(group.main), group.children.map(metric => JSON.stringify(metricDefinition(metric))).sort()]
}

/** A conservative legacy fallback: actual commands and targets, never display names. */
export function presetDefinitionFingerprint(item: CustomMetric | CustomMetricGroup, kind: 'metric' | 'group'): string {
    const scope = item.displayScope?.mode === 'selected' ? ['selected', [...new Set(item.displayScope.profileIds || [])].sort()] : ['all']
    if (item.displayScope?.mode === 'selected' && item.displayScope.excludedProfileIds?.length) {
        scope.push([...new Set(item.displayScope.excludedProfileIds)].sort())
    }
    return JSON.stringify([kind, definitionBody(item, kind), scope])
}

function scopeNames(scope: DisplayScope | undefined, excluded = false): string[] | undefined {
    if (scope?.mode !== 'selected') return undefined
    const ids = excluded ? scope.excludedProfileIds || [] : scope.profileIds || []
    return [...new Set(ids.map(id => scope.profileNames?.[id]).filter((name): name is string => typeof name === 'string' && Boolean(name.trim())))]
}

// Content-derived anonymous IDs are stable when a flat JSON library is reordered.
// Two independent 32-bit accumulators avoid storing entire shell scripts in config.
function contentId(value: string): string {
    let first = 2166136261, second = 5381
    for (let index = 0; index < value.length; index++) {
        const character = value.charCodeAt(index)
        first = Math.imul(first ^ character, 16777619)
        second = Math.imul(second, 33) ^ character
    }
    return `content-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`
}

function presetOrigin(entry: MetricPreset): PresetOrigin {
    const target = (entry.kind === 'group' ? entry.group! : entry.metric!) as PresetTarget
    const existing = target.presetOrigin
    if (existing?.kind === entry.kind && typeof existing.id === 'string' && existing.id && typeof existing.source === 'string') {
        return { id: existing.id, kind: entry.kind, source: canonicalPresetSource(existing.source) }
    }
    const source = canonicalPresetSource(entry.source?.url)
    const generated = /^(?:legacy|preset)-\d+$/.test(entry.id)
    // An anonymous file has no durable namespace for its IDs. Include its
    // definition so unrelated libraries with the same ID cannot block each other.
    const requestedNames = entry.profileNames ?? scopeNames(target.displayScope)
    const excludedNames = entry.excludedProfileNames ?? scopeNames(target.displayScope, true) ?? []
    const portableScope = requestedNames === undefined ? ['all'] : ['selected', [...new Set(requestedNames)].sort()]
    if (excludedNames.length) portableScope.push([...new Set(excludedNames)].sort())
    const id = generated || !source ? contentId(JSON.stringify([entry.kind, definitionBody(target, entry.kind), portableScope])) : entry.id
    return { id, source, kind: entry.kind }
}

/** Same preset remains installed after renaming, disabling or editing its rules. */
export function findInstalledPreset(preset: MetricPreset, config: { customMetrics?: CustomMetric[]; metricGroups?: CustomMetricGroup[] }, profiles: PresetProfile[] = []): { kind: 'metric' | 'group'; id: string } | null {
    const entry = normalizePresetLibrary([preset])[0]
    const origin = presetOrigin(entry)
    const installed = (entry.kind === 'metric' ? config.customMetrics || [] : config.metricGroups || []) as PresetTarget[]
    const direct = installed.find(item => item.presetOrigin?.kind === origin.kind && item.presetOrigin.id === origin.id &&
        canonicalPresetSource(item.presetOrigin.source) === origin.source)
    if (direct) return { kind: entry.kind, id: direct.id }

    const candidate = instantiatePreset(entry, profiles, () => 'comparison-only')
    const target = (entry.kind === 'metric' ? candidate.customMetrics[0] : candidate.metricGroups[0]) as PresetTarget
    const fingerprint = presetDefinitionFingerprint(target, entry.kind)
    // Old selected-empty scopes lost their intended missing connection names.
    // Without a saved origin, guessing equivalence could hide an unrelated preset.
    if (target.displayScope?.mode === 'selected' && !target.displayScope.profileIds.length) return null
    const legacy = installed.find(item => {
        if (item.presetOrigin) return false
        const source = canonicalPresetSource(item.presetMetadata?.source?.url)
        if (source && origin.source && source !== origin.source) return false
        return presetDefinitionFingerprint(item, entry.kind) === fingerprint
    })
    return legacy ? { kind: entry.kind, id: legacy.id } : null
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const localSource = { name: 'lishuainan0209 / Tabby Group Server Stats', url: 'https://github.com/lishuainan0209/tabby-group-server-stats', license: 'MIT' }

/** A failed query stays failed; empty or zero-capacity output is never shown as 0%. */
export function createGpuCommand(index?: number, detail = false): string {
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new Error('Invalid GPU index')
    const selected = index === undefined ? '' : ` --id=${index}`
    const result = detail ? 'printf "%.1f/%.1f GB\\n",used/1024,total/1024' : 'printf "%d\\n",used*100/total'
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
    return { id: index === undefined ? 'gpu-main' : `gpu-${index}`, label: index === undefined ? 'GPU用量' : `GPU ${index}`,
        type: 'text', icon: 'stats-vram', suffix: '%', color: METRIC_COLORS.green, interval: 30, timeout: 60,
        command: createGpuCommand(index), detailCommand: createGpuCommand(index, true),
        checkCommand: createGpuCheckCommand(index), checkMode: 'exitCode', checkExpected: '0', unavailableText: '无GPU',
        showWhenUnavailable: index === undefined, visibleWhenUnavailable: index === undefined,
        colorRules: usageColorRules(50, 80) }
}

export function createGpuGroupPreset(): MetricPreset {
    return { id: 'gpu-memory-group', kind: 'group', label: 'GPU用量', labels: { en: 'GPU usage', zh: 'GPU用量' },
        description: '显存使用率；悬停显示已用/总显存。自动隐藏不存在的 GPU 0–7。',
        descriptions: { en: 'VRAM use percentage; hover for used/total GB. Missing GPUs 0–7 are hidden.', zh: '显存使用率；悬停显示已用/总显存（GB）。自动隐藏不存在的 GPU 0–7。' },
        source: localSource,
        group: { id: 'gpu-memory-group', label: 'GPU用量', mode: 'overview', layout: 'vertical', interval: 3,
            displayScope: { mode: 'all', profileIds: [] }, main: gpuMetric(), children: Array.from({ length: 8 }, (_, index) => gpuMetric(index)) } }
}

// Emit only from END after validating the whole df result. An early awk exit
// still runs END, so printing there without a failure guard can turn errors into 0.
const diskValues = `awk 'NR==2 {if(NF<6 || $2 !~ /^[0-9]+$/ || $4 !~ /^[0-9]+$/ || $2<=0 || $4>$2) bad=1; else {total=$2; available=$4; found=1}} NR>2 && NF {bad=1} END {if(bad || !found) exit 1; printf "%.0f %.0f\\n",total,available}'`

/** Sum readable mounted filesystems once, even when bind mounts use different names. */
export function createDiskTotalCommand(mountPaths: string[], detail = false): string {
    const paths = ['/', ...new Set(mountPaths.filter(path => typeof path === 'string' && path.startsWith('/') && path !== '/'))]
    const result = detail ? 'printf "%.1f/%.1f GB\\n",available/1048576,total/1048576' : 'printf "%.0f\\n",int(available/1048576)'
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
        type: 'text', icon: system ? 'stats-system-disk' : 'stats-data-disk', color: METRIC_COLORS.green, suffix: ' GB', interval: 60, timeout: 60,
        checkCommand: system ? `test -d ${quoted} && df -Pk -- ${quoted} >/dev/null 2>&1` : `mountpoint -q -- ${quoted}`,
        checkMode: 'exitCode', checkExpected: '0', unavailableText: '未挂载', showWhenUnavailable: true, visibleWhenUnavailable: true,
        command: `${query} '{printf "%.0f\\n",int($2/1048576)}'`,
        detailCommand: `${query} '{printf "%.1f/%.1f GB\\n",$2/1048576,$1/1048576}'`,
        colorRules: capacityColorRules() }
}

export function createDiskGroupPreset(name: string, mountPaths: string[], profileNames: string[], template?: Partial<CustomMetricGroup>, optionalMountPaths: string[] = []): MetricPreset {
    const labOnly = /^P[0-4](?:容器)?磁盘$/.test(name)
    const noticeZh = labOnly ? '作者实验室自用，其他人请勿下载使用。' : ''
    const noticeEn = labOnly ? "For the author's laboratory only. Other users: please do not download or use this preset. " : ''
    const paths = [...new Set(mountPaths.filter(path => typeof path === 'string' && path.startsWith('/') && path !== '/'))]
    const optional = new Set(optionalMountPaths)
    const missingZh = paths.some(path => optional.has(path)) ? '可选挂载未挂载时自动隐藏；原有挂载保留异常提示。' : '未挂载的磁盘保留提醒。'
    const missingEn = paths.some(path => optional.has(path)) ? 'Missing optional mounts are hidden; existing mounts retain failure notices.' : 'Missing mounts remain visible.'
    const main: CustomMetric = { ...diskMetric('/', true, 0), id: 'disk-total', label: '磁盘余量', icon: 'stats-disk-space',
        // The aggregate validates every candidate itself; no valid rows is an
        // execution error, while a legitimately full readable filesystem is 0.
        checkCommand: '', command: createDiskTotalCommand(paths), detailCommand: createDiskTotalCommand(paths, true),
        colorRules: capacityColorRules(true) }
    const group: CustomMetricGroup = { ...clone(template || {}), id: 'disk-group', label: name, mode: template?.mode || 'overview',
        layout: template?.layout || 'vertical', interval: template?.interval || 3,
        main, children: [diskMetric('/', true, 0), ...paths.map((path, index) => ({ ...diskMetric(path, false, index),
            visibleWhenUnavailable: !optional.has(path), showWhenUnavailable: !optional.has(path) }))],
        displayScope: { mode: 'selected', profileIds: [] } }
    return { id: `disks-${name}`, kind: 'group', label: name, group, source: localSource, audience: labOnly ? 'author-lab' : undefined,
        description: noticeZh + '主标签汇总有效文件系统的总余量；子标签依次为系统盘和数据盘。悬停显示剩余/总容量。' + missingZh,
        descriptions: { en: noticeEn + 'Total free capacity across valid unique filesystems; children show the system disk first, then data mounts. Hover for free/total capacity. ' + missingEn, zh: noticeZh + '主标签汇总有效文件系统的总余量；子标签依次为系统盘和数据盘。悬停显示剩余/总容量。' + missingZh },
        profileNames: [...new Set(profileNames.map(profile => profile.trim()).filter(Boolean))] }
}

/** Lab mounts are shared with capacity presets, but counters describe block devices. */
export function createDiskIoGroupPreset(capacityPreset: MetricPreset, referenceByMount?: Record<string, number>): MetricPreset {
    if (!capacityPreset.group || !capacityPreset.id.startsWith('disks-')) throw new Error('A disk capacity group is required')
    const paths = ['/', ...capacityPreset.group.children.map(metric => metric.label || '').filter(label => label.startsWith('/') && label !== '/')]
    // Decimal MB/s. Known models override conservative class assumptions; future
    // and unverified mounts use a 4/8 TB HDD reference, not an invented disk model.
    const references: Record<string, number> = Object.fromEntries(paths.map(mount => [mount, 180]))
    if (capacityPreset.id === 'disks-P0磁盘') references['/'] = 500 // SSD-class logical volume; PERC hides its model.
    if (capacityPreset.id === 'disks-P3磁盘') Object.assign(references, { '/': 7000, '/data': 215, '/data2': 255 })
    if (capacityPreset.id === 'disks-P1容器磁盘') references['/public'] = 7000
    Object.assign(references, referenceByMount || {})
    const label = capacityPreset.label.replace(/磁盘$/, '磁盘读写')
    const optionalPaths = new Set(capacityPreset.group.children.filter(metric => metric.visibleWhenUnavailable === false).map(metric => metric.label))
    const metric = (mounts: string[], id: string, name: string, icon: string): CustomMetric => ({
        id, label: name, type: 'text', icon, color: METRIC_COLORS.green, suffix: ' MB/s',
        interval: 30, timeout: 15, checkMode: 'exitCode', checkExpected: '0',
        checkCommand: createDiskIoCheckCommand(mounts), command: createDiskIoCommand(mounts, false, references), detailCommand: createDiskIoCommand(mounts, true),
        valueFormat: 'disk-io-rate',
        colorRules: [{ operator: '>=', value: '95', color: METRIC_COLORS.red }, { operator: '>=', value: '80', color: METRIC_COLORS.orange }],
        unavailableText: '无块设备数据',
        visibleWhenUnavailable: mounts.length !== 1 || !optionalPaths.has(mounts[0]),
        showWhenUnavailable: mounts.length !== 1 || !optionalPaths.has(mounts[0]),
    })
    const descriptions = {
        zh: '作者实验室自用，其他人请勿下载使用。每30秒只读采样1秒；主标签汇总可读取的去重块设备读写速率，子标签对应系统盘和数据盘。悬停查看读/写 MB/s、读写平均延迟 await（毫秒，含排队）和平均在途 I/O 请求数 queue（不是文件数）。统计的是挂载点背后的块设备，并非该目录的独占流量；别名/绑定挂载不重复累计。MB采用1024进制。Overlay、网络盘或缺失挂载无块设备数据时保留提示，不显示虚假的0；不支持的设备不计入汇总。不做压力测试、不写磁盘文件。',
        en: "For the author's laboratory only. Other users: please do not download or use this preset. Every 30s, sample kernel counters for 1s. The main label sums readable unique block-device read/write throughput; children follow system/data mounts. Hover for read/write MB/s, read/write await in ms (including queueing) and average outstanding I/O requests (queue, not file count). These are backing-device totals, not exclusive directory traffic; aliases/bind mounts are counted once. MB uses base 1024. Overlay/network filesystems or missing mounts without block counters remain visibly unavailable and are excluded from the total. No benchmark or filesystem writes.",
    }
    if (capacityPreset.audience !== 'author-lab') {
        descriptions.zh = descriptions.zh.replace('作者实验室自用，其他人请勿下载使用。', '')
        descriptions.en = descriptions.en.replace("For the author's laboratory only. Other users: please do not download or use this preset. ", '')
    }
    if (optionalPaths.size) {
        descriptions.zh += '可选挂载校验失败时自动隐藏。'
        descriptions.en += ' Optional mounts are hidden when their prerequisite check fails.'
    }
    descriptions.zh += '颜色按读写总吞吐占参考带宽的比例：80%橙色、95%红色；显示值仍为MB/s。汇总参考只计本次可读取且去重的设备，不计未挂载预留盘。未知型号/预留盘采用180MB/s机械盘参考，具体型号及假设见README；这不是硬盘健康或繁忙率。'
    descriptions.en += ' Colors use total throughput / reference bandwidth: orange at 80%, red at 95%; readings remain MB/s. Aggregate references include only currently readable unique devices, never absent future mounts. Unknown/future disks use a 180 MB/s HDD reference; see README for known-model overrides and assumptions. This is not disk health or utilization.'
    return {
        id: `disk-io-${capacityPreset.id.slice('disks-'.length)}`, kind: 'group', label,
        labels: { zh: label, en: label.replace('容器', ' container ').replace('磁盘读写', ' disk I/O') },
        description: descriptions.zh, descriptions, source: localSource, audience: capacityPreset.audience,
        profileNames: [...(capacityPreset.profileNames || [])], excludedProfileNames: capacityPreset.excludedProfileNames?.slice(),
        group: {
            id: 'disk-io-group', label, mode: 'overview', layout: 'vertical', interval: 3,
            displayScope: { mode: 'selected', profileIds: [] },
            main: metric(paths, 'disk-io-total', '总读写', 'stats-disk-space'),
            children: paths.map((mount, index) => metric([mount], `disk-io-${index}`, mount === '/' ? '系统盘' : mount, mount === '/' ? 'stats-system-disk' : 'stats-data-disk')),
        },
    }
}

/** Alternative presentations retain the original scopes and checks. */
export function createGpuFreePreset(): MetricPreset {
    const p = createGpuGroupPreset()
    p.id = 'gpu-free-group'; p.label = 'GPU余量'; p.labels = { zh: 'GPU余量', en: 'GPU free' }
    p.description = '剩余显存百分比；悬停显示剩余/总显存。自动隐藏不存在的 GPU。'
    p.descriptions = { zh: p.description, en: 'Free VRAM percentage; hover for free/total memory. Missing GPUs are hidden.' }
    p.group!.id = p.id; p.group!.label = p.label; p.group!.main.label = p.label
    for (const m of [p.group!.main, ...p.group!.children]) {
        m.command = m.command.replace('used*100/total', 'free*100/total')
        m.detailCommand = m.detailCommand!.replace('used/1024,total/1024', 'free/1024,total/1024')
        m.colorRules = [{ operator: '<', value: '20', color: METRIC_COLORS.red }, { operator: '<', value: '50', color: METRIC_COLORS.orange }]
    }
    return p
}

export function createDiskUsagePreset(base: MetricPreset): MetricPreset {
    const p = clone(base)
    p.id = base.id + '-used'; p.label = base.label + '用量'
    p.labels = { zh: p.label, en: (base.labels?.en || base.label) + ' usage' }
    p.description = (base.audience === 'author-lab' ? '作者实验室自用，其他人请勿下载使用。' : '') + '已用容量百分比；悬停显示已用/总容量。大于80%橙色，大于90%红色。'
    p.descriptions = { zh: p.description, en: (base.audience === 'author-lab' ? "For the author's laboratory only. Other users: please do not download or use this preset. " : '') + 'Used disk percentage; hover for used/total capacity. Orange above 80%, red above 90%.' }
    p.group!.id = p.id; p.group!.label = p.label; p.group!.main.label = '磁盘用量'
    for (const m of [p.group!.main, ...p.group!.children]) {
        // df column 3 is used space; column 4 is space available to ordinary users.
        m.command = m.command.split(diskValues).join( diskValues.replace(/\$4/g, '$3')).replace('int(available/1048576)', 'available*100/total').replace('int($2/1048576)', '$2*100/$1')
        m.detailCommand = m.detailCommand!.split(diskValues).join( diskValues.replace(/\$4/g, '$3'))
        m.suffix = '%'; m.colorRules = usageColorRules(80, 90)
    }
    return p
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
        for (const key of ['profileNames', 'excludedProfileNames'] as const) {
            const names = result[key]
            if (names !== undefined) {
                if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('Invalid preset profile names')
                result[key] = [...new Set(names.map(name => name.trim()).filter(Boolean))]
            }
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
    const requestedNames = entry.profileNames ?? scopeNames(originalScope)
    const excludedNames = entry.excludedProfileNames ?? scopeNames(originalScope, true) ?? []
    const unnamedExclusion = entry.excludedProfileNames === undefined && originalScope?.mode === 'selected' &&
        (originalScope.excludedProfileIds || []).some(id => !originalScope.profileNames?.[id]?.trim())
    if (requestedNames !== undefined || excludedNames.length) {
        scope = { mode: 'selected', profileIds: [], profileNames: {} }
        const targets: PresetProfile[] = [...profiles, ...getLayoutPaneTargets(profiles).map(target => ({ id: target.id, name: layoutPaneTargetName(target) }))]
        for (const name of [...new Set(requestedNames || [])]) {
            const matches = targets.filter(profile => profile.id && profile.name?.trim() === name.trim())
            if (matches.length !== 1) { missingProfileNames.push(name); continue }
            scope.profileIds.push(matches[0].id!)
            scope.profileNames![matches[0].id!] = matches[0].name!
        }
        let missingExclusion = unnamedExclusion
        if (unnamedExclusion) missingProfileNames.push('Unnamed excluded pane / 未命名排除分屏')
        if (excludedNames.length) scope.excludedProfileIds = []
        for (const name of [...new Set(excludedNames)]) {
            const matches = targets.filter(profile => profile.id && profile.name?.trim() === name.trim())
            if (matches.length !== 1) { missingProfileNames.push(name); missingExclusion = true; continue }
            scope.excludedProfileIds!.push(matches[0].id!)
            scope.profileNames![matches[0].id!] = matches[0].name!
        }
        // Losing an opt-out must not turn a deliberately hidden pane back on.
        if (missingExclusion) scope.profileIds = []
    }
    const metric = (value: CustomMetric): CustomMetric => {
        const result = { ...clone(value), id: makeId(), displayScope: undefined } as PresetTarget
        delete result.presetOrigin
        return result as CustomMetric
    }
    const origin = presetOrigin(entry)
    if (entry.kind === 'metric') return { customMetrics: [{ ...metric(entry.metric!), displayScope: scope, presetOrigin: origin } as CustomMetric], metricGroups: [], missingProfileNames }
    const group = entry.group!
    return { customMetrics: [], metricGroups: [{ ...clone(group), id: makeId(), displayScope: scope, presetOrigin: origin,
        main: metric(group.main), children: group.children.map(metric) } as CustomMetricGroup], missingProfileNames }
}

/** Strip local binding IDs; shared presets contain commands plus portable profile names. */
export function exportPresetLibrary(presets: MetricPreset[]): string {
    const result = normalizePresetLibrary(presets).map(entry => {
        const target = entry.kind === 'group' ? entry.group! : entry.metric!
        if (target.displayScope?.mode === 'selected') {
            entry.profileNames = entry.profileNames ?? scopeNames(target.displayScope)
            entry.excludedProfileNames = entry.excludedProfileNames ?? scopeNames(target.displayScope, true)
            if ((target.displayScope.excludedProfileIds || []).some(id => !target.displayScope?.profileNames?.[id]?.trim())) {
                entry.profileNames = []
            }
        }
        target.displayScope = { mode: entry.profileNames === undefined ? 'all' : 'selected', profileIds: [] }
        if (entry.group) for (const metric of [entry.group.main, ...entry.group.children]) delete metric.displayScope
        return entry
    })
    return JSON.stringify(result, null, 2) + '\n'
}

/** Kept exported for offline library maintenance without temporary /tmp sample files. */
export const SAFE_IO_WAIT_COMMAND = createCpuSampleCommand('iowait')
export const SAFE_STEAL_COMMAND = createCpuSampleCommand('steal')
