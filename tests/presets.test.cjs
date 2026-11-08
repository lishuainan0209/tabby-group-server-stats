const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 }
}).outputText, filename)
const { getBuiltinDefaults, getBuiltinDefinition, getBuiltinDefinitions, createCpuSampleCommand, createCpuLoadCommand, createNetworkRateCommand } = require('../src/builtin-metrics.ts')
const { createGpuGroupPreset, createDiskGroupPreset, createDiskTotalCommand, createGpuCommand, createGpuCheckCommand, getBundledPresets, normalizePresetLibrary, instantiatePreset, exportPresetLibrary, findInstalledPreset, presetDefinitionFingerprint } = require('../src/preset-library.ts')
const { getLayoutPaneTargets, layoutPaneTargetName, matchesScope } = require('../src/display-scope.ts')
const gitExecPath = process.platform === 'win32' ? spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() : ''
const gitShell = gitExecPath ? path.resolve(gitExecPath, '../../..', 'bin/sh.exe') : ''
const shell = process.env.TEST_SH || (process.platform === 'win32' ? [gitShell, 'C:\\Program Files\\Git\\bin\\sh.exe', 'S:\\Git\\bin\\sh.exe'].find(file => file && fs.existsSync(file)) : '/bin/sh')
if (!shell) throw new Error('Install Git for Windows or set TEST_SH to its sh.exe')
const shellTools = process.platform === 'win32' ? path.resolve(path.dirname(shell), '../usr/bin') + path.delimiter : ''
function run(command, fake = '', env = {}) {
    const result = spawnSync(shell, ['-s'], { input: fake + '\n' + command + '\n', encoding: 'utf8', timeout: 5000,
        env: { ...process.env, PATH: shellTools + process.env.PATH, ...env } })
    if (result.error) throw result.error
    return result
}
const fakeNvidia = `nvidia-smi() {
    [ "$GPU_FAIL" = 1 ] && return 9
    selected=; query=
    for arg in "$@"; do
        case "$arg" in --id=*) selected=$\{arg#--id=};; --query-gpu=*) query=$\{arg#--query-gpu=};; esac
    done
    if [ -n "$selected" ]; then
        data=$(printf '%s\\n' "$GPU_MEMORY" | awk -v selectedNumber="$selected" 'NF && NR==selectedNumber+1')
        [ -n "$data" ] || return 6
        [ "$query" = index ] && printf '%s\\n' "$selected" || printf '%s\\n' "$data"
    elif [ "$GPU_ALL_FAIL" = 1 ]; then
        printf 'Unable to determine the device handle for GPU: Unknown Error\\n'
        return 9
    elif [ "$GPU_ALL_INVALID" = 1 ]; then
        printf 'Unavailable device data\\n'
    elif [ "$query" = index ]; then
        printf '%s\\n' "$GPU_MEMORY" | awk 'NF {print NR-1}'
    else printf '%s\\n' "$GPU_MEMORY"
    fi
}`
const memory8 = Array.from({ length: 8 }, (_, i) => `${512 * (i + 1)}, 8192, ${8192 - 512 * (i + 1) - 128}`).join('\n')

test('GPU memory percentage aggregates capacity and detail uses actual used memory', () => {
    assert.equal(run(createGpuCheckCommand(), fakeNvidia, { GPU_MEMORY: memory8 }).status, 0)
    const value = run(createGpuCommand(), fakeNvidia, { GPU_MEMORY: memory8 })
    assert.equal(value.status, 0, value.stderr)
    assert.equal(value.stdout.trim(), '28')
    assert.equal(run(createGpuCommand(undefined, true), fakeNvidia, { GPU_MEMORY: memory8 }).stdout.trim(), '18.0/64.0 GB')
    for (let index = 0; index < 8; index++) {
        assert.equal(run(createGpuCheckCommand(index), fakeNvidia, { GPU_MEMORY: memory8 }).status, 0)
        assert.equal(run(createGpuCommand(index), fakeNvidia, { GPU_MEMORY: memory8 }).stdout.trim(), String(Math.floor(512 * (index + 1) * 100 / 8192)))
    }
    assert.equal(run(createGpuCommand(0, true), fakeNvidia, { GPU_MEMORY: memory8 }).stdout.trim(), '0.5/8.0 GB')
    assert.notEqual(run(createGpuCheckCommand(8), fakeNvidia, { GPU_MEMORY: memory8 }).status, 0)
})

test('zero GPUs and failed queries are unavailable; malformed capacity cannot become 0%', () => {
    assert.notEqual(run(createGpuCheckCommand(), fakeNvidia, { GPU_MEMORY: '' }).status, 0)
    assert.notEqual(run(createGpuCheckCommand(0), fakeNvidia, { GPU_MEMORY: '' }).status, 0)
    assert.notEqual(run(createGpuCheckCommand(), fakeNvidia, { GPU_MEMORY: memory8, GPU_FAIL: '1' }).status, 0)
    for (const GPU_MEMORY of ['', '10, 0, 0', 'N/A, 8192, 0', '10, 8192', '10, 8192, N/A']) {
        const value = run(createGpuCommand(), fakeNvidia, { GPU_MEMORY })
        assert.notEqual(value.status, 0, GPU_MEMORY)
        assert.equal(value.stdout, '')
    }
    assert.notEqual(run(createGpuCommand(), fakeNvidia, { GPU_MEMORY: memory8, GPU_FAIL: '1' }).status, 0)
    assert.throws(() => createGpuCommand(-1))
    assert.throws(() => createGpuCheckCommand(0.5))
})

test('all-device failure or invalid output falls back to readable GPUs and sums their capacities', () => {
    const GPU_MEMORY = '16384, 24576, 7578\n1228, 24576, 22835'
    for (const failure of [{ GPU_ALL_FAIL: '1' }, { GPU_ALL_INVALID: '1' }]) {
        const env = { GPU_MEMORY, ...failure }
        assert.equal(run(createGpuCheckCommand(), fakeNvidia, env).status, 0)
        const value = run(createGpuCommand(), fakeNvidia, env)
        assert.equal(value.status, 0, value.stderr)
        assert.equal(value.stdout.trim(), '35')
        assert.equal(run(createGpuCommand(undefined, true), fakeNvidia, env).stdout.trim(), '17.2/48.0 GB')
        assert.equal(run(createGpuCommand(0), fakeNvidia, env).stdout.trim(), '66')
        assert.equal(run(createGpuCommand(1), fakeNvidia, env).stdout.trim(), '4')
    }
    const mixed = { GPU_MEMORY: 'N/A, 8192, 0\n512, 0, 0\n1024, 8192, 7000', GPU_ALL_FAIL: '1' }
    assert.equal(run(createGpuCommand(), fakeNvidia, mixed).stdout.trim(), '12')
    assert.equal(run(createGpuCommand(undefined, true), fakeNvidia, mixed).stdout.trim(), '1.0/8.0 GB')
    assert.notEqual(run(createGpuCheckCommand(), fakeNvidia, { GPU_MEMORY: '', GPU_ALL_FAIL: '1' }).status, 0)
    assert.notEqual(run(createGpuCommand(), fakeNvidia, { GPU_MEMORY: '', GPU_ALL_FAIL: '1' }).status, 0)
})

test('GPU group has eight optional children and a visible failure notice on its main label', () => {
    const preset = createGpuGroupPreset()
    const bundled = getBundledPresets()
    for (const metric of [bundled.find(p => p.id === preset.id).group.main, bundled.find(p => p.id === 'single-gpu-memory').metric]) {
        assert.equal(metric.command, preset.group.main.command)
        assert.equal(metric.detailCommand, preset.group.main.detailCommand)
        assert.equal(metric.checkCommand, preset.group.main.checkCommand)
    }
    assert.equal(preset.group.main.unavailableText, '无GPU')
    assert.equal(preset.group.main.type, 'text')
    assert.equal(preset.group.main.suffix, '%')
    assert.equal(preset.group.main.visibleWhenUnavailable, true)
    assert.equal(preset.group.children.length, 8)
    assert.equal(preset.group.displayScope.mode, 'all')
    for (const child of preset.group.children) {
        assert.equal(child.visibleWhenUnavailable, false)
        assert.equal(child.showWhenUnavailable, false)
        assert.equal(child.checkMode, 'exitCode')
        assert.equal(child.checkExpected, '0')
        assert.equal((child.command.match(/nvidia-smi/g) || []).length, 1)
        assert.equal((child.detailCommand.match(/nvidia-smi/g) || []).length, 1)
    }
})

test('disk presets quote mount paths, keep disappeared disks visible and propagate df failure', () => {
    const mount = `/data/a'$(printf INJECTED >&2); b`
    const preset = createDiskGroupPreset('Test', [mount, mount, '/'], [' P3(ai) ', 'P3(s_lsn)'])
    assert.equal(preset.group.children.length, 2)
    assert.deepEqual(preset.profileNames, ['P3(ai)', 'P3(s_lsn)'])
    const metric = preset.group.children[1]
    const check = run(metric.checkCommand, 'mountpoint() { printf "%s\\n" "$@"; }')
    assert.equal(check.status, 0)
    assert.equal(check.stderr, '')
    assert.equal(check.stdout.trim().split('\n').at(-1), mount)
    const fakeDf = `df() { [ "$3" = "$EXPECTED_MOUNT" ] || return 9; printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 104857600 52428800 52428800 50%% /fake\\n'; }`
    assert.equal(run(metric.command, fakeDf, { EXPECTED_MOUNT: mount }).stdout.trim(), '50')
    assert.equal(run(metric.detailCommand, fakeDf, { EXPECTED_MOUNT: mount }).stdout.trim(), '50.0/100.0 GB')
    assert.notEqual(run(metric.command, `df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 104857600 52428800 52428800 50%% /fake\\n'; return 9; }`).status, 0)
    assert.equal(metric.visibleWhenUnavailable, true)
    assert.equal(metric.showWhenUnavailable, true)
    assert.equal(preset.group.main.label, '磁盘余量')
    assert.equal(preset.group.main.id, 'disk-total')
    assert.equal(preset.group.children[0].id, 'disk-root')
    assert.equal(preset.group.children[0].label, '系统盘')
    assert.equal(new Set([preset.group.main.id, ...preset.group.children.map(m => m.id)]).size, 3)
    assert.equal(preset.group.main.colorRules[0].operator, '<')
    assert.equal(metric.colorRules[0].operator, '<')
})

test('disk and GPU presets use the requested green/orange/red boundaries in priority order', () => {
    const disk = createDiskGroupPreset('Example', ['/data'], []).group
    const gpu = createGpuGroupPreset().group
    assert.equal(disk.main.color, '#00ff00')
    assert.deepEqual(disk.main.colorRules, [{ operator: '<', value: '50', color: '#ff0000' }, { operator: '<=', value: '100', color: '#ffa500' }])
    for (const child of disk.children) {
        assert.equal(child.color, '#00ff00')
        assert.deepEqual(child.colorRules, [{ operator: '<', value: '20', color: '#ff0000' }, { operator: '<=', value: '40', color: '#ffa500' }])
    }
    for (const metric of [gpu.main, ...gpu.children]) {
        assert.equal(metric.color, '#00ff00')
        assert.deepEqual(metric.colorRules, [{ operator: '>', value: '80', color: '#ff0000' }, { operator: '>', value: '50', color: '#ffa500' }])
    }
})

const fakeFilesystems = `
mountpoint() {
    case "$3" in
        /missing) return 1;;
        /flaky) mount_checks=$((mount_checks+1)); [ "$mount_checks" -eq 1 ];;
        /data|/alias|/root-bind|/unreadable) return 0;;
        *) [ "$3" = "$EXPECTED_MOUNT" ];;
    esac
}
stat() {
    [ "$DISK_MODE" = stat-failure ] && return 9
    [ "$DISK_MODE" = bad-device ] && { printf 'unknown\\n'; return; }
    case "$4" in
        /|/root-bind) printf '10\\n';;
        /data|/alias) printf '20\\n';;
        /missing|/flaky) printf '30\\n';;
        /unreadable) printf '40\\n';;
        *) [ "$4" = "$EXPECTED_MOUNT" ] && printf '20\\n';;
    esac
}
df() {
    [ "$DISK_MODE" = df-failure ] && return 9
    [ "$DISK_MODE" = empty ] && return 0
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
    case "$DISK_MODE" in
        malformed) printf '/dev/bad N/A 0 0 0%% /\\n'; return;;
        zero-total) printf '/dev/bad 0 0 0 0%% /\\n'; return;;
        invalid-free) printf '/dev/bad 104857600 0 N/A 0%% /\\n'; return;;
        excess-free) printf '/dev/bad 104857600 0 209715200 0%% /\\n'; return;;
        full) printf '/dev/full 104857600 104857600 0 100%% /\\n'; return;;
        header-only) return;;
    esac
    case "$3" in
        /) [ "$ROOT_FAIL" = 1 ] && return 9; printf '/dev/root 104857600 78643200 26214400 75%% /\\n';;
        /root-bind|/missing|/flaky) printf '/dev/root-alias 104857600 78643200 26214400 75%% /bound\\n';;
        /data) printf '/dev/data 209715200 131072000 78643200 63%% /data\\n';;
        /alias) printf '/dev/another-source-name 209715200 131072000 78643200 63%% /alias\\n';;
        /unreadable) printf '/dev/misleading 314572800 0 314572800 0%% /unreadable\\n'; return 9;;
        *) [ "$3" = "$EXPECTED_MOUNT" ] || return 9; printf '/dev/example 209715200 131072000 78643200 63%% /example\\n';;
    esac
}
`

test('disk totals sum valid unique filesystems and never count absent mounts or failed df output', () => {
    const paths = ['/data', '/alias', '/root-bind', '/missing', '/unreadable', '/flaky']
    const group = createDiskGroupPreset('Example', paths, []).group
    const value = run(group.main.command, fakeFilesystems)
    assert.equal(value.status, 0, value.stderr)
    assert.equal(value.stdout.trim(), '100')
    assert.equal(run(group.main.detailCommand, fakeFilesystems).stdout.trim(), '100.0/300.0 GB')
    assert.equal(run(group.main.command, fakeFilesystems, { ROOT_FAIL: '1' }).stdout.trim(), '100', 'Root bind remains a valid sample when only the root query fails')
    assert.equal(run(createDiskTotalCommand(['/data']), fakeFilesystems, { ROOT_FAIL: '1' }).stdout.trim(), '75')
    assert.equal(run(createDiskTotalCommand(['/data'], true), fakeFilesystems, { ROOT_FAIL: '1' }).stdout.trim(), '75.0/200.0 GB')
    assert(group.children.every(metric => metric.showWhenUnavailable === true && metric.visibleWhenUnavailable === true))
    assert.equal(group.children[0].label, '系统盘')
    assert.equal(group.main.checkCommand, '', 'The aggregate must report no readable results as an execution error')
})

test('disk totals and children reject empty or malformed rows while allowing a truly full filesystem', () => {
    const group = createDiskGroupPreset('Root only', [], []).group
    assert.equal(group.children.length, 1)
    for (const DISK_MODE of ['df-failure', 'empty', 'header-only', 'malformed', 'zero-total', 'invalid-free', 'excess-free']) {
        for (const command of [group.main.command, group.main.detailCommand, group.children[0].command, group.children[0].detailCommand]) {
            const result = run(command, fakeFilesystems, { DISK_MODE })
            assert.notEqual(result.status, 0, DISK_MODE)
            assert.equal(result.stdout, '', `${DISK_MODE} must not print a misleading zero or partial sum from awk END`)
        }
    }
    for (const DISK_MODE of ['stat-failure', 'bad-device']) {
        const result = run(group.main.command, fakeFilesystems, { DISK_MODE })
        assert.notEqual(result.status, 0, DISK_MODE)
        assert.equal(result.stdout, '')
    }
    const full = run(group.main.command, fakeFilesystems, { DISK_MODE: 'full' })
    assert.equal(full.status, 0, full.stderr)
    assert.equal(full.stdout.trim(), '0')
    assert.equal(run(group.main.detailCommand, fakeFilesystems, { DISK_MODE: 'full' }).stdout.trim(), '0.0/100.0 GB')
})

test('disk totals quote shell-sensitive paths without executing their contents', () => {
    const mount = `/data/a'$(printf INJECTED >&2); b`
    const result = run(createDiskTotalCommand([mount, mount, '/']), fakeFilesystems, { EXPECTED_MOUNT: mount })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), '100')
    assert.equal(result.stderr, '')
})

test('portable profile bindings resolve locally and never become global when missing or ambiguous', () => {
    const preset = createDiskGroupPreset('P1', ['/public'], ['P1(s_lsn)'])
    let serial = 0
    const ids = () => `new-${++serial}`
    const local = instantiatePreset(preset, [{ id: 'local-a', name: 'P1(s_lsn)' }, { id: 'local-b', name: 'P1(ai)' }], ids)
    assert.deepEqual(local.metricGroups[0].displayScope.profileIds, ['local-a'])
    assert.deepEqual(local.missingProfileNames, [])
    for (const profiles of [[], [{ id: 'a', name: 'P1(s_lsn)' }, { id: 'b', name: 'P1(s_lsn)' }]]) {
        const missing = instantiatePreset(preset, profiles, ids)
        assert.equal(missing.metricGroups[0].displayScope.mode, 'selected')
        assert.deepEqual(missing.metricGroups[0].displayScope.profileIds, [])
        assert.deepEqual(missing.missingProfileNames, ['P1(s_lsn)'])
    }
    preset.profileNames = []
    const empty = instantiatePreset(normalizePresetLibrary(JSON.parse(exportPresetLibrary([preset])))[0], [], ids)
    assert.equal(empty.metricGroups[0].displayScope.mode, 'selected')
    assert.deepEqual(empty.metricGroups[0].displayScope.profileIds, [])
    assert.notEqual(local.metricGroups[0].id, local.metricGroups[0].main.id)
})

test('shared library removes local binding IDs and keeps the offline single/group inventory', () => {
    const presets = getBundledPresets()
    assert.equal(presets.filter(p => p.kind === 'metric').length, 12)
    assert.equal(presets.filter(p => p.kind === 'group').length, 14)
    assert.equal(new Set(presets.map(p => p.id)).size, 26)
    const host = presets.find(p => p.label === 'P1磁盘')
    const container = presets.find(p => p.label === 'P1容器磁盘')
    assert.deepEqual(host.profileNames, ['P1(ai)'])
    assert.deepEqual(container.profileNames, ['P1(s_lsn)'])
    assert.deepEqual(host.group.children.map(m => m.label), ['系统盘'])
    assert.deepEqual(container.group.children.map(m => m.label), ['系统盘', '/public'])
    assert.equal(host.labels.en, 'P1 host disks')
    assert.equal(container.labels.en, 'P1 container disks')
    assert.deepEqual(host.group, createDiskGroupPreset('P1磁盘', [], ['P1(ai)']).group)
    assert.deepEqual(container.group, createDiskGroupPreset('P1容器磁盘', ['/public'], ['P1(s_lsn)']).group)
    const profiles = [{ id: 'host', name: 'P1(ai)' }, { id: 'container', name: 'P1(s_lsn)' }]
    assert.deepEqual(instantiatePreset(host, profiles).metricGroups[0].displayScope.profileIds, ['host'])
    assert.deepEqual(instantiatePreset(container, profiles).metricGroups[0].displayScope.profileIds, ['container'])
    assert.deepEqual(presets.find(p => p.label === 'P3磁盘').group.children.map(m => m.label), ['系统盘', '/data', '/data2'])
    const source = createGpuGroupPreset()
    source.group.displayScope = { mode: 'selected', profileIds: ['private-local-id'], profileNames: { 'private-local-id': 'My profile' } }
    source.group.children[0].displayScope = { mode: 'selected', profileIds: ['private-child-id'] }
    const shared = exportPresetLibrary([source])
    assert.doesNotMatch(shared, /private-local-id|private-child-id/)
    assert.deepEqual(JSON.parse(shared)[0].profileNames, ['My profile'])
    assert.equal(normalizePresetLibrary([{ command: 'printf 1', label: 'Legacy' }])[0].metric.type, 'text')
    assert.throws(() => normalizePresetLibrary({ invalid: true }))
})

test('preset origin prevents repeated installation after rename, disable and rule or scope edits', () => {
    const preset = createGpuGroupPreset()
    const config = instantiatePreset(preset, [], () => 'installed-gpu')
    const group = config.metricGroups[0]
    assert.deepEqual(group.presetOrigin, { id: preset.id, source: preset.source.url, kind: 'group' })
    assert.equal(group.main.presetOrigin, undefined)
    assert(group.children.every(child => child.presetOrigin === undefined))
    group.label = 'My renamed GPUs'
    group.enabled = false
    group.main.command = 'printf custom'
    group.main.colorRules = []
    group.displayScope = { mode: 'selected', profileIds: ['different-local-target'] }
    assert.deepEqual(findInstalledPreset(preset, config, []), { kind: 'group', id: group.id })
    preset.source.name = 'New translated source title'
    preset.source.url += '.git/'
    assert.deepEqual(findInstalledPreset(preset, config, []), { kind: 'group', id: group.id })
    config.metricGroups = []
    assert.equal(findInstalledPreset(preset, config, []), null, 'Removing a preset permits adding it again')
})

test('source namespaces separate different libraries with the same preset ID', () => {
    const first = createGpuGroupPreset()
    const second = JSON.parse(JSON.stringify(first))
    second.source.url = 'https://example.com/another-library'
    const config = instantiatePreset(first, [])
    assert.equal(findInstalledPreset(second, config), null)
    delete config.metricGroups[0].presetOrigin
    config.metricGroups[0].presetMetadata = { source: first.source }
    assert.equal(findInstalledPreset(second, config), null, 'Known old sources must not be collapsed across libraries')
})

test('legacy matching uses commands and actual target IDs, not names, colors or member order', () => {
    const preset = createDiskGroupPreset('P3磁盘', ['/data', '/data2'], ['P3'])
    const profiles = [{ id: 'p3-id', name: 'P3' }, { id: 'p4-id', name: 'P4' }]
    const config = instantiatePreset(preset, profiles)
    const group = config.metricGroups[0]
    delete group.presetOrigin
    group.label = 'Renamed disks'
    group.enabled = false
    group.main.color = '#123456'
    group.children.reverse()
    group.children[0].label = 'Renamed mount'
    group.main.command = '\r\n' + group.main.command.replace(/\n/g, '\r\n') + '\r\n'
    assert.deepEqual(findInstalledPreset(preset, config, profiles), { kind: 'group', id: group.id })
    group.displayScope.profileIds = ['p4-id']
    assert.equal(findInstalledPreset(preset, config, profiles), null, 'Same disk commands on another machine are distinct')
    group.displayScope.profileIds = ['p3-id']
    group.children[0].detailCommand += '\nprintf different'
    assert.equal(findInstalledPreset(preset, config, profiles), null, 'Different commands are not a duplicate just because the name matches')
})

test('legacy comparison normalizes check defaults while respecting units and empty selected scopes', () => {
    const preset = { id: 'single', kind: 'metric', label: 'Metric', metric: { id: 'single', command: 'printf 50', type: 'text', suffix: '%', checkCommand: 'test -d /data' } }
    const config = instantiatePreset(preset, [])
    const metric = config.customMetrics[0]
    delete metric.presetOrigin
    metric.checkMode = 'exitCode'; metric.checkExpected = '0'
    assert.deepEqual(findInstalledPreset(preset, config), { kind: 'metric', id: metric.id })
    metric.suffix = 'GB'
    assert.equal(findInstalledPreset(preset, config), null)
    const selected = { ...preset, profileNames: ['missing-machine'] }
    const old = instantiatePreset(selected, [])
    delete old.customMetrics[0].presetOrigin
    assert.equal(findInstalledPreset(selected, old), null, 'Old empty bindings lack enough information to establish identity safely')
    const current = instantiatePreset(selected, [])
    assert.deepEqual(findInstalledPreset(selected, current), { kind: 'metric', id: current.customMetrics[0].id })
})

test('legacy GiB display labels do not allow duplicate presets, while paths and calculations stay distinct', () => {
    const profiles = [{ id: 'p3', name: 'P3' }]
    for (const preset of [createGpuGroupPreset(), createDiskGroupPreset('P3', ['/data'], ['P3'])]) {
        const config = instantiatePreset(preset, profiles)
        const group = config.metricGroups[0]
        delete group.presetOrigin
        for (const metric of [group.main, ...group.children]) {
            metric.suffix = metric.suffix?.replace(/\bGB\b/g, 'GiB')
            metric.detailCommand = metric.detailCommand?.replace(/\bGB\b/g, 'GiB')
        }
        const original = JSON.stringify(group)
        assert.deepEqual(findInstalledPreset(preset, config, profiles), { kind: 'group', id: group.id })
        assert.equal(JSON.stringify(group), original, 'Comparing aliases must not rewrite installed commands')
        group.main.detailCommand = group.main.detailCommand.replace(/\/1024\b|\/1048576\b/, '/1000')
        assert.equal(findInstalledPreset(preset, config, profiles), null, 'Actual numeric conversion changes remain distinct')
    }
    const metric = { id: 'disk', command: 'df /GiB', detailCommand: 'printf "%.1f/%.1f GiB\\n" 1 2', suffix: 'GiB', type: 'text' }
    const alias = { ...metric, detailCommand: 'printf "%.1f/%.1f GB\\n" 1 2', suffix: 'GB' }
    assert.equal(presetDefinitionFingerprint(metric, 'metric'), presetDefinitionFingerprint(alias, 'metric'))
    for (const changed of [
        { ...alias, command: 'df /GB' },
        { ...alias, detailCommand: 'cat /GB' },
        { ...alias, checkCommand: 'test -d /GiB' },
        { ...alias, suffix: 'MB' },
    ]) assert.notEqual(presetDefinitionFingerprint(metric, 'metric'), presetDefinitionFingerprint(changed, 'metric'))
    const originalText = { ...metric, detailCommand: 'printf "GiB storage"' }
    const changedText = { ...metric, detailCommand: 'printf "GB storage"' }
    assert.notEqual(presetDefinitionFingerprint(originalText, 'metric'), presetDefinitionFingerprint(changedText, 'metric'))
})

test('anonymous and reordered flat libraries identify content instead of positional generated IDs', () => {
    const first = normalizePresetLibrary([{ label: 'Same name', command: 'printf 1' }, { label: 'Same name', command: 'printf 2' }])
    const config = instantiatePreset(first[0], [])
    assert.equal(findInstalledPreset(first[1], config), null)
    const reordered = normalizePresetLibrary([{ label: 'Other', command: 'printf 3' }, { label: 'Renamed', command: 'printf 1' }])
    assert.deepEqual(findInstalledPreset(reordered[1], config), { kind: 'metric', id: config.customMetrics[0].id })
    const unrelated = normalizePresetLibrary([{ label: 'Same name', command: 'printf 4' }])[0]
    assert.equal(findInstalledPreset(unrelated, config), null)
    assert.equal(findInstalledPreset({ ...first[0], profileNames: [] }, config), null, 'Anonymous selected-empty is distinct from global')
})

test('export and reimport preserve origin even when portable entry IDs change', () => {
    const preset = createGpuGroupPreset()
    const config = instantiatePreset(preset, [])
    const entry = { ...preset, id: 'new-export-local-id', group: config.metricGroups[0] }
    const exported = normalizePresetLibrary(JSON.parse(exportPresetLibrary([entry])))[0]
    assert.deepEqual(exported.group.presetOrigin, config.metricGroups[0].presetOrigin)
    assert.deepEqual(findInstalledPreset(exported, config), { kind: 'group', id: config.metricGroups[0].id })
    const imported = instantiatePreset(exported, [])
    assert.deepEqual(findInstalledPreset(preset, imported), { kind: 'group', id: imported.metricGroups[0].id })
    assert.equal(presetDefinitionFingerprint(imported.metricGroups[0], 'group'), presetDefinitionFingerprint(config.metricGroups[0], 'group'))
})

function layoutScopeFixture(prefix) {
    const connection = { id: prefix + '-connection', name: 'Shared SSH', type: 'ssh', options: { host: 'node.example.test', port: 2222, user: 'analyst' } }
    const layout = { id: prefix + '-layout', name: 'Research panes', type: 'split-layout', options: { recoveryToken: {
        type: 'app:split-tab', children: [
            { type: 'app:ssh-tab', profile: connection },
            { type: 'app:ssh-tab', profile: connection },
        ],
    } } }
    return [connection, layout]
}

test('portable layout pane scopes retain individual exclusions across different local IDs', () => {
    const sourceProfiles = layoutScopeFixture('source-private')
    const panes = getLayoutPaneTargets(sourceProfiles)
    const preset = createGpuGroupPreset()
    preset.group.displayScope = { mode: 'selected', profileIds: [sourceProfiles[1].id, panes[0].id],
        excludedProfileIds: [panes[1].id], profileNames: {
            [sourceProfiles[1].id]: sourceProfiles[1].name,
            [panes[0].id]: layoutPaneTargetName(panes[0]),
            [panes[1].id]: layoutPaneTargetName(panes[1]),
        } }
    const text = exportPresetLibrary([preset])
    assert.doesNotMatch(text, /source-private/)
    const exported = normalizePresetLibrary(JSON.parse(text))[0]
    assert.deepEqual(exported.profileNames, ['Research panes', layoutPaneTargetName(panes[0])])
    assert.deepEqual(exported.excludedProfileNames, [layoutPaneTargetName(panes[1])])
    const destinationProfiles = layoutScopeFixture('destination-private')
    const destinationPanes = getLayoutPaneTargets(destinationProfiles)
    const imported = instantiatePreset(exported, destinationProfiles)
    const scope = imported.metricGroups[0].displayScope
    assert.deepEqual(imported.missingProfileNames, [])
    assert.deepEqual(scope.profileIds, [destinationProfiles[1].id, destinationPanes[0].id])
    assert.deepEqual(scope.excludedProfileIds, [destinationPanes[1].id])
    assert(matchesScope(scope, { profileIds: [destinationProfiles[1].id, destinationPanes[0].id] }, destinationProfiles))
    assert(!matchesScope(scope, { profileIds: [destinationProfiles[1].id, destinationPanes[1].id] }, destinationProfiles))
})

test('portable pane selection works after its original saved connection has been deleted', () => {
    const profiles = layoutScopeFixture('private')
    const pane = getLayoutPaneTargets(profiles)[1]
    const preset = { id: 'single-pane', kind: 'metric', label: 'Only pane two', profileNames: [layoutPaneTargetName(pane)],
        metric: { id: 'value', command: 'printf 7', type: 'text' } }
    const result = instantiatePreset(preset, [profiles[1]])
    assert.deepEqual(result.customMetrics[0].displayScope.profileIds, [pane.id])
    assert.deepEqual(result.missingProfileNames, [])
})

test('missing, renamed or ambiguous portable exclusions fail closed instead of widening the scope', () => {
    const profiles = layoutScopeFixture('first')
    const panes = getLayoutPaneTargets(profiles)
    const preset = { id: 'exclude-second', kind: 'metric', label: 'Metric', profileNames: ['Shared SSH'],
        excludedProfileNames: [layoutPaneTargetName(panes[1])], metric: { id: 'value', command: 'printf 7', type: 'text' } }
    for (const destination of [
        [profiles[0]],
        [profiles[0], { ...profiles[1], name: 'Renamed layout' }],
        [...profiles, layoutScopeFixture('another')[1]],
    ]) {
        const result = instantiatePreset(preset, destination)
        assert.equal(result.customMetrics[0].displayScope.mode, 'selected')
        assert.deepEqual(result.customMetrics[0].displayScope.profileIds, [])
        assert.deepEqual(result.missingProfileNames, preset.excludedProfileNames)
    }
    const unnamed = createGpuGroupPreset()
    unnamed.group.displayScope = { mode: 'selected', profileIds: ['private-layout'], excludedProfileIds: ['private-pane'],
        profileNames: { 'private-layout': 'Research panes' } }
    const direct = instantiatePreset(unnamed, profiles)
    assert.deepEqual(direct.metricGroups[0].displayScope.profileIds, [], 'Direct imports must also retain unnamed opt-outs safely')
    assert.equal(direct.missingProfileNames.length, 1)
    const exported = JSON.parse(exportPresetLibrary([unnamed]))[0]
    assert.deepEqual(exported.profileNames, [], 'An exclusion without a portable name cannot be dropped')
    assert.doesNotMatch(JSON.stringify(exported), /private-layout|private-pane/)
    assert.throws(() => normalizePresetLibrary([{ ...preset, excludedProfileNames: 'not an array' }]))
    assert.throws(() => normalizePresetLibrary([{ ...preset, excludedProfileNames: [7] }]))
})

test('preset identity distinguishes excluded panes and never imports exclusion names as inclusions', () => {
    const profiles = layoutScopeFixture('private')
    const panes = getLayoutPaneTargets(profiles)
    const preset = { id: 'anonymous', kind: 'metric', label: 'Metric', metric: {
        id: 'value', command: 'printf 7', type: 'text', displayScope: { mode: 'selected', profileIds: [profiles[1].id],
            excludedProfileIds: [panes[1].id], profileNames: { [profiles[1].id]: profiles[1].name, [panes[1].id]: layoutPaneTargetName(panes[1]) } },
    } }
    const first = instantiatePreset(preset, profiles)
    assert.deepEqual(first.customMetrics[0].displayScope.profileIds, [profiles[1].id])
    const secondPreset = JSON.parse(JSON.stringify(preset))
    secondPreset.metric.displayScope.excludedProfileIds = []
    const second = instantiatePreset(secondPreset, profiles)
    assert.notEqual(first.customMetrics[0].presetOrigin.id, second.customMetrics[0].presetOrigin.id)
    assert.notEqual(presetDefinitionFingerprint(first.customMetrics[0], 'metric'), presetDefinitionFingerprint(second.customMetrics[0], 'metric'))
    assert.equal(findInstalledPreset(secondPreset, first, profiles), null)
})

test('built-in overrides are independent drafts, preserve stable IDs and honor legacy flags/icons', () => {
    const defaults = getBuiltinDefaults()
    defaults.cpu.command = 'MUTATED'
    assert.notEqual(getBuiltinDefaults().cpu.command, 'MUTATED')
    const conf = { defaultMetrics: { ram: true, net: true, load: false }, showDefaultIcons: false,
        defaultMetricOverrides: { ram: { ...getBuiltinDefaults().ram, id: 'ignored', command: 'printf 42', displayScope: { mode: 'selected', profileIds: [] } } } }
    const visible = getBuiltinDefinitions(conf)
    assert.equal(visible.customMetrics.length, 1)
    assert.equal(visible.customMetrics[0].command, 'printf 42')
    assert.equal(visible.customMetrics[0].id, 'builtin-ram')
    assert.equal(visible.customMetrics[0].icon, '')
    assert.equal(visible.customMetrics[0].displayScope.mode, 'selected')
    assert.equal(visible.metricGroups[0].main.enabled, false)
    assert.equal(visible.metricGroups[0].children[0].icon, '')
    assert.equal(getBuiltinDefinition('ram', conf).icon, 'stats-memory')
    assert.equal(getBuiltinDefinitions({ defaultMetrics: {} }).customMetrics.length, 0)
    assert.equal(getBuiltinDefinitions().customMetrics.length, 1)
    assert.equal(getBuiltinDefinitions().metricGroups.length, 2)
})

test('CPU load normalizes Linux and Darwin load without truncating detail values or accepting invalid cores', () => {
    const fakeDarwin = `uname() { printf 'Darwin\\n'; }
sysctl() { case "$2" in hw.logicalcpu) printf '%s\\n' "$CORES";; vm.loadavg) printf '{ 4.25 6.75 8.50 }\\n';; esac; }
ps() { printf 'R\\nS\\nR+\\nI\\n'; }`
    const env = { CORES: '4' }
    assert.equal(run(createCpuLoadCommand(1), fakeDarwin, env).stdout.trim(), '106')
    assert.equal(run(createCpuLoadCommand(5), fakeDarwin, env).stdout.trim(), '168')
    assert.equal(run(createCpuLoadCommand(5, true), fakeDarwin, env).stdout.trim(), '6.75/4')
    assert.equal(run(getBuiltinDefaults().load.main.command, fakeDarwin, env).stdout.trim(), '2/4')
    for (const CORES of ['0', '', 'bad', '4.2']) assert.notEqual(run(createCpuLoadCommand(1), fakeDarwin, { CORES }).status, 0)
    const fakeLinux = `uname() { printf 'Linux\\n'; }
getconf() { printf '4\\n'; }
nproc() { printf '4\\n'; }`
    // Feed a deterministic /proc sample into the real awk expression.
    const sample = "4.25 6.75 8.50 3/100 123"
    const linux = (command) => command.replace(/\/proc\/loadavg;/g, "<<'LOAD_SAMPLE'\n" + sample + '\nLOAD_SAMPLE\n')
    assert.equal(run(linux(createCpuLoadCommand(1)), fakeLinux).stdout.trim(), '106')
    assert.equal(run(linux(createCpuLoadCommand(5, true)), fakeLinux).stdout.trim(), '6.75/4')
})

test('sampling commands use no shared temp files and Darwin built-ins keep working', () => {
    for (const command of [createCpuSampleCommand(), createCpuSampleCommand('iowait'), createCpuSampleCommand('steal'), createNetworkRateCommand('rx'), createNetworkRateCommand('tx')]) {
        assert.doesNotMatch(command, /\/tmp\/|mktemp/)
        assert.match(command, /sleep 1/)
    }
    const defaults = getBuiltinDefaults()
    const fakeDarwin = `uname() { printf 'Darwin\\n'; }
sysctl() { case "$2" in hw.logicalcpu) printf '4\\n';; hw.memsize) printf '1073741824\\n';; vm.loadavg) printf '{ 0.5 1.0 1.5 }\\n';; esac; }
ps() { printf '20\\n40\\n60\\n80\\n'; }
vm_stat() { printf 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\\nPages free: 65536.\\nPages inactive: 32768.\\nPages speculative: 32768.\\n'; }`
    assert.equal(run(defaults.cpu.command, fakeDarwin).stdout.trim(), '50.0')
    assert.equal(run(defaults.ram.command, fakeDarwin).stdout.trim(), '50.0')
    assert.equal(run(defaults.ram.detailCommand, fakeDarwin).stdout.trim(), '0.5/1.0 GB available')
    assert.equal(run(defaults.cpu.detailCommand, fakeDarwin).stdout.trim(), '{ 0.5 1.0 1.5 }')
    assert.notEqual(run(defaults.disk.command, 'df() { return 9; }').status, 0)
})
