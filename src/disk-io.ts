import { shellQuote } from './metric-model'

/** Read kernel block-device counters, never benchmark or touch filesystem data.
 * MAJ:MIN identifies the mounted block device (including partitions and LVM).
 * It deliberately does not guess a host disk for overlay, NFS or other virtual FS.
 */
function diskIoPrelude(mountPaths: string[]): string {
    const paths = [...new Set(mountPaths.filter(path => typeof path === 'string' && path.startsWith('/')))]
    if (!paths.length) throw new Error('At least one absolute mount path is required')
    return `[ -r /proc/diskstats ] && [ -r /proc/uptime ] && command -v findmnt >/dev/null 2>&1 || exit 1
tabby_io_devices() {
    for io_path in ${paths.map(shellQuote).join(' ')}; do
        io_device=$(findmnt -rn -o MAJ:MIN --mountpoint "$io_path" 2>/dev/null) || continue
        printf '%s\\n' "$io_device"
    done | awk '/^[0-9]+:[0-9]+$/ && !seen[$0]++ {print}'
}
tabby_io_resolve() {
    io_candidates=$(tabby_io_devices) || return 1
    awk -v devices="$io_candidates" 'BEGIN {n=split(devices,a,"\\n"); for(i=1;i<=n;i++) selected[a[i]]=1} ($1 ":" $2) in selected && NF>=14 {print $1 ":" $2; found=1} END {if(!found) exit 1}' /proc/diskstats
}
io_devices=$(tabby_io_resolve) || exit 1
tabby_io_snapshot() {
    awk -v devices="$io_devices" 'BEGIN {n=split(devices,a,"\\n"); for(i=1;i<=n;i++) selected[a[i]]=1} ($1 ":" $2) in selected {
        if(NF<14) {bad=1; next}
        for(i=4;i<=14;i++) if($i !~ /^[0-9]+$/) bad=1
        print $1 ":" $2,$4,$6,$7,$8,$10,$11,$14
        seen[$1 ":" $2]=1
    } END {for(device in selected) if(!seen[device]) bad=1; if(bad) exit 1}' /proc/diskstats
}`
}

/** Any readable requested device makes a total available; missing children stay visible. */
export function createDiskIoCheckCommand(mountPaths: string[]): string {
    // Checks need only resolve and validate counters, not define the sampling
    // functions used by the value/detail commands. Keep the same failure rules.
    const prelude = diskIoPrelude(mountPaths);
    const devices = prelude.slice(0, prelude.indexOf('\ntabby_io_resolve()'));
    return `${devices}
io_candidates=$(tabby_io_devices) || exit 1
awk -v devices="$io_candidates" 'BEGIN {n=split(devices,a,"\\n"); for(i=1;i<=n;i++) selected[a[i]]=1}
($1 ":" $2) in selected && NF>=14 {found=1; for(i=4;i<=14;i++) if($i !~ /^[0-9]+$/) bad=1}
END {exit (!found || bad)}' /proc/diskstats`;
}

/** Upgrade only the exact old generated check; edited/custom shell stays intact. */
export function compactDiskIoCheck(command?: string): string | undefined {
    if (!command?.endsWith('\ntabby_io_snapshot >/dev/null')) return command;
    const args = /for io_path in (.+); do/.exec(command)?.[1];
    const quoted = args?.match(/'[^']*'/g) || [];
    const paths = quoted.map(value => value.slice(1, -1));
    if (!paths.length || paths.some(path => !path.startsWith('/')) || quoted.join(' ') !== args) return command;
    if (command !== `${diskIoPrelude(paths)}\ntabby_io_snapshot >/dev/null`) return command;
    return createDiskIoCheckCommand(paths);
}

export function migrateDiskIoChecks(config: any): boolean {
    let changed = false;
    const metrics = [...(config?.customMetrics || [])];
    for (const group of config?.metricGroups || []) metrics.push(group.main, ...(group.children || []));
    for (const metric of metrics) {
        if (!metric) continue;
        const compact = compactDiskIoCheck(metric.checkCommand);
        if (compact !== metric.checkCommand) { metric.checkCommand = compact; changed = true; }
    }
    return changed;
}

/** Reference speeds are manufacturer decimal MB/s, while counters use base 1024. */
function diskIoReferencePrelude(mountPaths: string[], referenceByMount: Record<string, number>): string {
    const paths = [...new Set(mountPaths)]
    for (const mount of paths) {
        const reference = referenceByMount?.[mount]
        if (typeof mount !== 'string' || !mount.startsWith('/') ||
            !Object.prototype.hasOwnProperty.call(referenceByMount || {}, mount) ||
            !Number.isFinite(reference) || reference <= 0) {
            throw new Error('Every mount path requires a positive finite disk I/O reference speed')
        }
    }
    const cases = paths.map((mount, index) =>
        `            ${shellQuote(mount)}) io_reference=${referenceByMount[mount] / 1.048576}; io_slot=${index};;`).join('\n')
    return `tabby_io_reference() {
    for io_path in ${paths.map(shellQuote).join(' ')}; do
        io_device=$(findmnt -rn -o MAJ:MIN --mountpoint "$io_path" 2>/dev/null) || continue
        case "$io_path" in
${cases}
        esac
        printf '%s %s %s\\n' "$io_device" "$io_slot" "$io_reference"
    done | awk -v devices="$io_devices" '
    BEGIN {n=split(devices,a,"\\n"); for(i=1;i<=n;i++) selected[a[i]]=1}
    $1 in selected {
        if(NF!=3 || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$/ || $3+0<=0) {bad=1; next}
        print; seen[$1]=1
    }
    END {for(device in selected) if(!seen[device]) bad=1; if(bad) exit 1}'
}
io_reference_rows=$(tabby_io_reference) || exit 1
io_reference_total=$(printf '%s\\n' "$io_reference_rows" | awk '
    {if(!($1 in reference) || $3+0<reference[$1]) reference[$1]=$3+0}
    END {for(device in reference) total+=reference[device]; if(total<=0) exit 1; printf "%.17g\\n",total}') || exit 1`
}

/** One-second sample every 30s. Bytes use the kernel's fixed 512-byte sector unit.
 * await = delta(read_ms + write_ms) / delta(completed reads + writes).
 * queue = weighted I/O milliseconds / elapsed milliseconds (requests, not files).
 * Exact devices are deduplicated, including bind mounts on the same device.
 */
export function createDiskIoCommand(mountPaths: string[], detail = false, referenceByMount?: Record<string, number>): string {
    // Validate supplied maps even when rendering the unchanged detail command.
    const referencePrelude = referenceByMount === undefined ? '' : diskIoReferencePrelude(mountPaths, referenceByMount)
    const normalized = !detail && referenceByMount !== undefined
    return `${diskIoPrelude(mountPaths)}${normalized ? '\n' + referencePrelude : ''}
io_before=$(tabby_io_snapshot) || exit 1
io_start=$(awk 'NR==1 {print $1; exit}' /proc/uptime) || exit 1
sleep 1
io_after=$(tabby_io_snapshot) || exit 1
io_finish=$(awk 'NR==1 {print $1; exit}' /proc/uptime) || exit 1
io_current=$(tabby_io_resolve) || exit 1
[ "$io_devices" = "$io_current" ] || exit 1${normalized ? '\nio_reference_current=$(tabby_io_reference) || exit 1\n[ "$io_reference_rows" = "$io_reference_current" ] || exit 1' : ''}
printf '%s\\n--TABBY-IO-NEXT--\\n%s\\n' "$io_before" "$io_after" | awk -v start="$io_start" -v finish="$io_finish" -v detail=${detail ? 1 : 0}${normalized ? ' -v reference="$io_reference_total"' : ''} '
BEGIN {if(start !~ /^[0-9]+([.][0-9]+)?$/ || finish !~ /^[0-9]+([.][0-9]+)?$/ || finish<=start) {bad=1; exit 1}; seconds=finish-start}
$0=="--TABBY-IO-NEXT--" {second=1; next}
!second {for(i=2;i<=8;i++) before[$1,i]=$i; seen[$1]=1; next}
{
    if(!($1 in seen)) {bad=1; next}
    for(i=2;i<=8;i++) {delta[i]=$i-before[$1,i]; if(delta[i]<0) bad=1}
    reads+=delta[2]; rsectors+=delta[3]; rtime+=delta[4]
    writes+=delta[5]; wsectors+=delta[6]; wtime+=delta[7]; weighted+=delta[8]; count++
}
END {
    if(bad || !count) exit 1
    readMB=rsectors/2048/seconds; writeMB=wsectors/2048/seconds
    if(detail) {
        latency=reads+writes>0?sprintf("%.1f ms",(rtime+wtime)/(reads+writes)):"-"
        printf "R %.2f / W %.2f MB/s | await %s | queue %.2f\\n",readMB,writeMB,latency,weighted/(seconds*1000)
    } else ${normalized ? 'if(reference !~ /^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$/ || reference+0<=0) exit 1; else printf "TABBY-IO:%.2f:%.8f\\n",readMB+writeMB,100*(readMB+writeMB)/reference' : 'printf "%.2f\\n",readMB+writeMB'}
}'`
}
