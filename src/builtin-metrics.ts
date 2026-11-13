import { CustomMetric, CustomMetricGroup } from './metric-model'
import { METRIC_COLORS, usageColorRules } from './metric-colors'

export type BuiltinMetricKey = 'ram' | 'net' | 'load'
export type LegacyBuiltinMetricKey = 'cpu' | 'disk'
type StoredBuiltinMetricKey = BuiltinMetricKey | LegacyBuiltinMetricKey
export interface BuiltinDefinitions { cpu: CustomMetric; ram: CustomMetric; disk: CustomMetric; net: CustomMetricGroup; load: CustomMetricGroup }
export interface BuiltinConfig {
    defaultMetrics?: Partial<Record<StoredBuiltinMetricKey, boolean>>
    defaultMetricOverrides?: Partial<BuiltinDefinitions>
    showDefaultIcons?: boolean
    builtinOrder?: StoredBuiltinMetricKey[]
    builtinDefaultsVersion?: number
    customMetrics?: CustomMetric[]
    metricGroups?: CustomMetricGroup[]
}

const builtinKeys: readonly BuiltinMetricKey[] = ['ram', 'net', 'load']

/** Keep disabled slots in the saved order; only the visible definitions are filtered. */
export function normalizeBuiltinOrder(value?: readonly unknown[]): BuiltinMetricKey[] {
    const supplied = Array.isArray(value) ? value : []
    return [...new Set([...supplied.filter((key): key is BuiltinMetricKey => builtinKeys.includes(key as BuiltinMetricKey)), ...builtinKeys])]
}

export interface OrderedMetricItem { id: string; metric?: CustomMetric; group?: CustomMetricGroup }

/** Mix built-in singles and groups before the unchanged custom item order. */
export function orderBuiltinItems(metrics: CustomMetric[], groups: CustomMetricGroup[], order?: readonly unknown[]): OrderedMetricItem[] {
    const ranks = new Map(normalizeBuiltinOrder(order).map((key, index) => [`builtin-${key}`, index]))
    const items: OrderedMetricItem[] = [
        ...metrics.map(metric => ({ id: metric.id, metric })),
        ...groups.map(group => ({ id: group.id, group }))
    ]
    return items.sort((a, b) => (ranks.get(a.id) ?? builtinKeys.length) - (ranks.get(b.id) ?? builtinKeys.length))
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const usageRules = [
    { operator: '>=' as const, value: '90', color: METRIC_COLORS.red },
    { operator: '>=' as const, value: '75', color: METRIC_COLORS.orange }
]

const darwinMemory = (detail: boolean): string => {
    const result = detail ? 'printf "%.1f/%.1f GB available\\n",available/1073741824,total/1073741824' : 'printf "%.1f\\n",(total-available)*100/total'
    return `total=$(sysctl -n hw.memsize 2>/dev/null) || exit 1; data=$(vm_stat 2>/dev/null) || exit 1; printf '%s\\n' "$data" | awk -v total="$total" '/page size of/ {for(i=1;i<NF;i++) if($i=="of") size=$(i+1)} /^Pages free:/ {free=$3+0} /^Pages inactive:/ {inactive=$3+0} /^Pages speculative:/ {speculative=$3+0} END {if(total<=0 || size<=0) exit 1; available=(free+inactive+speculative)*size; if(available>total) available=total; ${result}}'`
}
const linuxOrDarwin = (linux: string, darwin: string): string => `if [ "$(uname -s)" = Darwin ]; then ${darwin}; else ${linux}; fi`

/** Load is normalized by logical processor count, not the busy-CPU percentage. */
export function createCpuLoadCommand(minutes: 1 | 5, detail = false): string {
    const field = minutes === 1 ? 1 : 2
    const result = detail ? 'printf "%.2f/%d\\n",load,cores' : 'printf "%d\\n",load*100/cores'
    const parse = `awk -v cores="$cores" -v field=${field} 'BEGIN {if(cores !~ /^[0-9]+$/ || cores<=0) {bad=1; exit 1}} {gsub(/[{}]/, ""); load=$field; if(load !~ /^[0-9]+([.][0-9]+)?$/) {bad=1; exit 1} found=1; ${result}; exit} END {if(bad || !found) exit 1}'`
    return linuxOrDarwin(
        `cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null) || cores=$(nproc 2>/dev/null) || exit 1; ${parse} /proc/loadavg`,
        `cores=$(sysctl -n hw.logicalcpu 2>/dev/null) || exit 1; data=$(sysctl -n vm.loadavg 2>/dev/null) || exit 1; printf '%s\\n' "$data" | ${parse}`,
    )
}

function createCpuLoadGroup(): CustomMetricGroup {
    const shared: Partial<CustomMetric> = { type: 'text', color: METRIC_COLORS.green, icon: 'stats-cpu-load', interval: 15,
        checkMode: 'exitCode', checkExpected: '0', unavailableText: 'Unavailable' }
    const child = (minutes: 1 | 5): CustomMetric => ({ ...shared, id: `builtin-load-${minutes}min`,
        type: 'text', label: `${minutes}min`, suffix: '%', colorRules: usageColorRules(100, 150),
        checkCommand: linuxOrDarwin('test -r /proc/loadavg', 'command -v sysctl >/dev/null'),
        command: createCpuLoadCommand(minutes), detailCommand: createCpuLoadCommand(minutes, true) })
    return { id: 'builtin-load', label: 'CPU load', mode: 'overview', layout: 'vertical',
        main: { ...shared, id: 'builtin-load-main', label: 'Threads', type: 'text',
            checkCommand: linuxOrDarwin('test -r /proc/loadavg', 'command -v ps >/dev/null'),
            command: linuxOrDarwin(`awk '$4 ~ /^[0-9]+\\/[0-9]+$/ {print $4; found=1; exit} END {if(!found) exit 1}' /proc/loadavg`,
                `data=$(ps -A -M -o state= 2>/dev/null) || exit 1; printf '%s\\n' "$data" | awk 'NF {total++; if($1 ~ /^R/) running++} END {if(!total) exit 1; printf "%d/%d\\n",running,total}'`) },
        children: [child(1), child(5)] }
}

/** Each sample owns its shell variables; concurrent panes never share a temp file. */
export function createCpuSampleCommand(counter: 'busy' | 'iowait' | 'steal' = 'busy'): string {
    const field = counter === 'busy' ? '$5+$6' : counter === 'iowait' ? '$6' : '$9'
    const read = `awk '/^cpu / { t=0; for(i=2;i<=9;i++) t+=$i; print t,${field}; found=1; exit } END { if(!found) exit 1 }' /proc/stat`
    const delta = counter === 'busy' ? 'dt-(v-v1)' : 'v-v1'
    return `a=$(${read}) || exit 1; sleep 1; b=$(${read}) || exit 1; printf '%s\\n%s\\n' "$a" "$b" | awk 'NR==1 { t1=$1; v1=$2 } NR==2 { dt=$1-t1; v=$2; result=dt>0?(${delta})*100/dt:0; if(result<0) result=0; if(result>100) result=100; printf "%.1f\\n",result }'`
}

// Default-route interfaces are counted once. Without a default route, use the
// available non-loopback interfaces, omitting Linux slave/down interfaces when
// sysfs is available. This also works inside containers without physical NICs.
const linuxNetworkRows = `awk 'NR>2 { sub(/^[[:space:]]+/, ""); split($0,a,/[[:space:]:]+/); if(a[1]!="lo" && a[1] ~ /^[[:alnum:]_.:-]+$/ && a[2] ~ /^[0-9]+$/ && a[10] ~ /^[0-9]+$/) { print a[1],a[2],a[10]; count++ } } END {if(!count) exit 1}' /proc/net/dev`
const darwinNetworkRows = `net_data=$(netstat -ibn 2>/dev/null) || return 1; printf '%s\\n' "$net_data" | awk '$1=="Name" {columns=NF; for(i=1;i<=NF;i++) {if($i=="Ibytes") ri=i; if($i=="Obytes") ti=i} next} $3 ~ /^<Link#[0-9]+>/ && $1 !~ /\\*$/ && $1!="lo0" && $1 ~ /^[[:alnum:]_.:-]+$/ {r=NF-columns+ri; t=NF-columns+ti; if(ri && ti && r>3 && t>3 && $r ~ /^[0-9]+$/ && $t ~ /^[0-9]+$/ && !seen[$1]++) {print $1,$r,$t; count++}} END {if(!count) exit 1}'`
const networkPrelude = `net_os=$(uname -s) || exit 1;
tabby_net_rows() { if [ "$net_os" = Darwin ]; then ${darwinNetworkRows}; else ${linuxNetworkRows}; fi; };
tabby_net_interfaces() {
    if [ "$net_os" = Darwin ]; then
        net_candidates=$({ route -n get default 2>/dev/null; route -n get -inet6 default 2>/dev/null; } | awk '$1=="interface:" {print $2}');
    else
        net_candidates=$({ awk 'NR>1 && $2=="00000000" && $8=="00000000" && $4 ~ /[13579bBdDfF]$/ {print $1}' /proc/net/route 2>/dev/null; awk '$1=="00000000000000000000000000000000" && $2=="00" && $9 ~ /[13579bBdDfF]$/ {print $10}' /proc/net/ipv6_route 2>/dev/null; });
    fi;
    net_candidates=$(printf '%s\\n' "$net_candidates" | awk -v rows="$1" 'BEGIN {n=split(rows,a,"\\n"); for(i=1;i<=n;i++) {split(a[i],b," "); available[b[1]]=1}} available[$1] && !seen[$1]++ {printf "%s%s",sep,$1; sep=" "}');
    if [ -n "$net_candidates" ]; then printf '%s\\n' "$net_candidates"; return 0; fi;
    printf '%s\\n' "$1" | while read -r net_iface net_rx net_tx; do
        if [ "$net_os" != Darwin ]; then
            [ -e "/sys/class/net/$net_iface/master" ] && continue;
            if [ -r "/sys/class/net/$net_iface/operstate" ]; then read -r net_state < "/sys/class/net/$net_iface/operstate"; case "$net_state" in up|unknown) ;; *) continue;; esac; fi;
        fi;
        printf '%s\\n' "$net_iface";
    done | awk '!seen[$1]++ {printf "%s%s",sep,$1; sep=" "}';
};
tabby_net_snapshot() {
    net_rows=$(tabby_net_rows) || return 1;
    printf '%s\\n' "$net_rows" | awk -v interfaces="$net_interfaces" 'BEGIN {n=split(interfaces,a," "); for(i=1;i<=n;i++) selected[a[i]]=1} $1 in selected {print; seen[$1]=1} END {for(name in selected) if(!seen[name]) exit 1}';
};
net_rows=$(tabby_net_rows) || exit 1;
net_interfaces=$(tabby_net_interfaces "$net_rows") || exit 1;
[ -n "$net_interfaces" ] || exit 1;`

export function createNetworkRateCommand(direction: 'rx' | 'tx' | 'total'): string {
    const delta = direction === 'rx' ? 'dr' : direction === 'tx' ? 'dt' : 'dr+dt'
    return `${networkPrelude}
tabby_net_clock() { if [ "$net_os" = Darwin ]; then if command -v perl >/dev/null 2>&1; then perl -MTime::HiRes=time -e 'printf "%.6f\\n", time' 2>/dev/null || date +%s; else date +%s; fi; else awk 'NR==1 {print $1; found=1; exit} END {if(!found) exit 1}' /proc/uptime; fi; };
a=$(tabby_net_snapshot) || exit 1; ta=$(tabby_net_clock) || exit 1; sleep 1;
b=$(tabby_net_snapshot) || exit 1; tb=$(tabby_net_clock) || exit 1;
printf '%s\\n--TABBY-NET-NEXT--\\n%s\\n' "$a" "$b" | awk -v start="$ta" -v finish="$tb" 'BEGIN {if(start !~ /^[0-9]+([.][0-9]+)?$/ || finish !~ /^[0-9]+([.][0-9]+)?$/ || finish<=start) {bad=1; exit 1}} $0=="--TABBY-NET-NEXT--" {second=1; next} !second {rx[$1]=$2; tx[$1]=$3; next} {if(!($1 in rx)) {bad=1; next} dr=$2-rx[$1]; dt=$3-tx[$1]; if(dr<0) dr=0; if(dt<0) dt=0; bytes+=${delta}; count++} END {if(bad || !count) exit 1; rate=bytes/1024/(finish-start); if(rate>=1) printf "%.2f\\n",rate; else if(rate>0) printf "%.6f\\n",rate; else print "0"}'`
}

export function createNetworkDetailCommand(direction: 'rx' | 'tx' | 'total'): string {
    const label = direction === 'rx' ? 'Received' : direction === 'tx' ? 'Sent' : 'Combined'
    const value = direction === 'rx' ? '$2' : direction === 'tx' ? '$3' : '$2+$3'
    return `${networkPrelude}
data=$(tabby_net_snapshot) || exit 1; printf '%s\\n' "$data" | awk -v interfaces="$net_interfaces" '{bytes+=${value}; count++} END {if(!count) exit 1; gsub(/ /,",",interfaces); printf "${label} total: %.3f GB (since interface reset; %s)\\n",bytes/1073741824,interfaces}'`
}

/** Fresh objects are returned so settings drafts cannot mutate the factory defaults. */
export function getBuiltinDefaults(): BuiltinDefinitions {
    const common = { type: 'progress' as const, maxValue: 100, suffix: '%', color: METRIC_COLORS.green, colorRules: usageRules, checkMode: 'exitCode' as const, checkExpected: '0', unavailableText: 'Unavailable' }
    const netMetric = (id: string, label: string, direction: 'rx' | 'tx' | 'total', icon: string): CustomMetric => ({
        id, label, type: 'text', icon, color: METRIC_COLORS.green, suffix: ' KiB/s', interval: 5,
        command: createNetworkRateCommand(direction), checkCommand: linuxOrDarwin('test -r /proc/net/dev && test -r /proc/uptime', 'command -v netstat >/dev/null && command -v route >/dev/null && command -v date >/dev/null'),
        checkMode: 'exitCode', checkExpected: '0', unavailableText: 'Unavailable',
        detailCommand: createNetworkDetailCommand(direction)
    })
    const definitions: BuiltinDefinitions = {
        cpu: { ...common, id: 'builtin-cpu', label: 'CPU', icon: 'stats-cpu',
            command: linuxOrDarwin(createCpuSampleCommand(), `cores=$(sysctl -n hw.logicalcpu 2>/dev/null) || exit 1; data=$(ps -A -o %cpu= 2>/dev/null) || exit 1; printf '%s\\n' "$data" | awk -v cores="$cores" '{sum+=$1} END {if(cores<=0) exit 1; usage=sum/cores; if(usage>100) usage=100; printf "%.1f\\n",usage}'`),
            checkCommand: linuxOrDarwin('test -r /proc/stat', 'command -v ps >/dev/null && command -v sysctl >/dev/null'),
            detailCommand: linuxOrDarwin(`awk '{printf "load %.2f / %.2f / %.2f\\n",$1,$2,$3}' /proc/loadavg`, `sysctl -n vm.loadavg`) },
        ram: { ...common, id: 'builtin-ram', label: 'Memory', icon: 'stats-memory', interval: 10,
            colorRules: usageColorRules(60, 80),
            checkCommand: linuxOrDarwin('test -r /proc/meminfo', 'command -v vm_stat >/dev/null && command -v sysctl >/dev/null'),
            command: linuxOrDarwin(`awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2; found=1} /^MemFree:/ {f=$2} /^Buffers:/ {b=$2} /^Cached:/ {c=$2} END {if(t<=0) exit 1; if(!found) a=f+b+c; printf "%.1f\\n",(t-a)*100/t}' /proc/meminfo`, darwinMemory(false)),
            detailCommand: linuxOrDarwin(`awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2; found=1} /^MemFree:/ {f=$2} /^Buffers:/ {b=$2} /^Cached:/ {c=$2} END {if(t<=0) exit 1; if(!found) a=f+b+c; printf "%.1f/%.1f GB available\\n",a/1048576,t/1048576}' /proc/meminfo`, darwinMemory(true)) },
        disk: { ...common, id: 'builtin-disk', label: 'Disk', icon: 'stats-system-disk',
            checkCommand: 'df -Pk / >/dev/null 2>&1',
            command: `data=$(df -Pk / 2>/dev/null) || exit 1; printf '%s\\n' "$data" | awk 'NR==2 {gsub(/%/,"",$5); print $5; found=1} END {if(!found) exit 1}'`,
            detailCommand: `data=$(df -Pk / 2>/dev/null) || exit 1; printf '%s\\n' "$data" | awk 'NR==2 {printf "%.1f/%.1f GB available\\n",$4/1048576,$2/1048576; found=1} END {if(!found) exit 1}'` },
        net: { id: 'builtin-net', label: 'Network', mode: 'static', layout: 'vertical',
            main: netMetric('builtin-net-main', 'Network', 'total', 'stats-network'),
            children: [netMetric('builtin-net-rx', 'Download', 'rx', 'stats-network-download'), netMetric('builtin-net-tx', 'Upload', 'tx', 'stats-network-upload')] },
        load: createCpuLoadGroup()
    }
    return clone(definitions)
}

/** Editing ignores legacy visibility switches so a disabled built-in can be configured. */
export function getBuiltinDefinition<K extends StoredBuiltinMetricKey>(key: K, conf: BuiltinConfig = {}): BuiltinDefinitions[K] {
    const defaults = getBuiltinDefaults()
    const override = conf.defaultMetricOverrides?.[key]
    if (key === 'net' || key === 'load') {
        const saved = override as CustomMetricGroup | undefined
        const base = defaults[key] as CustomMetricGroup
        return clone({ ...base, ...saved, id: base.id,
            main: { ...base.main, ...saved?.main, id: base.main.id },
            children: saved?.children ?? base.children
        }) as BuiltinDefinitions[K]
    }
    return clone({ ...defaults[key], ...override, id: defaults[key].id }) as BuiltinDefinitions[K]
}

/** UI and collection consume the same editable built-in definitions. */
export function getBuiltinDefinitions(conf: BuiltinConfig = {}): { customMetrics: CustomMetric[]; metricGroups: CustomMetricGroup[] } {
    const flags = conf.defaultMetrics || { ram: true, net: true, load: true }
    const order = normalizeBuiltinOrder(conf.builtinOrder)
    const customMetrics = flags.ram ? [getBuiltinDefinition('ram', conf)] : []
    const metricGroups = order.filter((key): key is 'net' | 'load' => key !== 'ram' && !!flags[key]).map(key => getBuiltinDefinition(key, conf))
    if (conf.showDefaultIcons === false) {
        customMetrics.forEach(metric => { metric.icon = '' })
        metricGroups.forEach(group => { group.main.icon = ''; group.children.forEach(metric => { metric.icon = '' }) })
    }
    return { customMetrics, metricGroups }
}

function isExistingCpuLoadGroup(group: CustomMetricGroup): boolean {
    const origin = (group as CustomMetricGroup & { presetOrigin?: { kind?: string; id?: string; source?: string } }).presetOrigin
    if (origin?.kind === 'group' && origin.id === 'cpu-load-group' &&
        /^https?:\/\/github\.com\/lishuainan0209\/tabby-group-server-stats(?:\.git)?\/?$/i.test(origin.source || '')) return true
    const normalize = (value?: string) => value?.replace(/\r\n?/g, '\n').trim() || ''
    // Pre-origin imports used these exact commands. Display names are not identity.
    if (normalize(group.main?.command) !== "awk '{print $4}' /proc/loadavg" || group.children?.length !== 2) return false
    const commands = group.children.map(child => normalize(child.command)).sort()
    return [1, 2].map(field => `awk '{printf "%d\\n", ($${field}/'$(nproc)')*100}' /proc/loadavg`).sort()
        .every((command, index) => commands[index] === command)
}

/** One-time, lossless upgrade; the caller saves config only when this returns true. */
export function migrateLegacyBuiltinConfig(conf: BuiltinConfig): boolean {
    if ((conf.builtinDefaultsVersion || 0) >= 2) return false
    migrateLegacyCpuDiskConfig(conf)
    const main = conf.defaultMetricOverrides?.net?.main
    const factory = getBuiltinDefaults().net.main
    // Old settings saved the disabled factory main with the rest of the group.
    // Upgrade only that stock main; keep custom commands, appearance and scope.
    // A versioned migration also respects any later deliberate disable action.
    if (main?.enabled === false && Object.entries(main).every(([key, value]) =>
        key === 'enabled' || JSON.stringify(value) === JSON.stringify(factory[key as keyof CustomMetric]))) {
        main.enabled = true
    }
    conf.builtinDefaultsVersion = 2
    return true
}

function migrateLegacyCpuDiskConfig(conf: BuiltinConfig): boolean {
    if ((conf.builtinDefaultsVersion || 0) >= 1) return false
    // Tabby exposes structural config objects through getter-only properties.
    // Read only declared flags: spreading its proxy also copies internal helpers.
    const flags = {
        ram: conf.defaultMetrics?.ram ?? true,
        net: conf.defaultMetrics?.net ?? true,
        load: conf.defaultMetrics?.load ?? true,
        cpu: conf.defaultMetrics?.cpu ?? false,
        disk: conf.defaultMetrics?.disk ?? false,
    }
    const metrics = [...(conf.customMetrics || [])]
    const usedIds = new Set([...metrics.map(metric => metric.id), ...(conf.metricGroups || []).flatMap(group =>
        [group.id, group.main?.id, ...(group.children || []).map(metric => metric.id)])])
    for (const key of ['cpu', 'disk'] as const) {
        if (flags[key] === true || conf.defaultMetricOverrides?.[key]) {
            const definition = getBuiltinDefinition(key, conf)
            const baseId = `legacy-builtin-${key}`
            let id = baseId, suffix = 2
            while (usedIds.has(id)) id = `${baseId}-${suffix++}`
            usedIds.add(id)
            metrics.push({ ...definition, id, enabled: flags[key] === true && definition.enabled !== false })
        }
        flags[key] = false
    }
    // Keep the user's existing group, its bindings and its disabled state intact.
    // Its presence means introducing another default load group would duplicate it.
    if (!conf.defaultMetricOverrides?.load && (conf.metricGroups || []).some(isExistingCpuLoadGroup)) flags.load = false
    conf.customMetrics = metrics
    if (!conf.defaultMetrics) conf.defaultMetrics = {}
    Object.assign(conf.defaultMetrics, flags)
    conf.builtinOrder = normalizeBuiltinOrder(conf.builtinOrder)
    conf.builtinDefaultsVersion = 1
    return true
}
