const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename)
const { createDiskIoCommand, createDiskIoCheckCommand, compactDiskIoCheck, migrateDiskIoChecks } = require('../src/disk-io.ts')
const { createDiskIoGroupPreset, getBundledPresets, instantiatePreset } = require('../src/preset-library.ts')
const gitExecPath = process.platform === 'win32' ? spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() : ''
const gitShell = gitExecPath ? path.resolve(gitExecPath, '../../..', 'bin/sh.exe') : ''
const shell = process.env.TEST_SH || (process.platform === 'win32' ? [gitShell, 'C:\\Program Files\\Git\\bin\\sh.exe', 'S:\\Git\\bin\\sh.exe'].find(file => file && fs.existsSync(file)) : '/bin/sh')
if (!shell) throw Error('Install Git for Windows or set TEST_SH to its sh.exe')
const shellTools = process.platform === 'win32' ? path.resolve(path.dirname(shell), '../usr/bin') + path.delimiter : ''
const row = (id = '8:1', values = [100, 2048, 1000, 200, 4096, 2000, 5000]) => {
    const [major, minor] = id.split(':'); const [r, rs, rt, w, ws, wt, weighted] = values
    return `${major} ${minor} disk${major}_${minor} ${r} 0 ${rs} ${rt} ${w} 0 ${ws} ${wt} 0 0 ${weighted}`
}
function run(command, { before = [row()], after = before, mounts = { '/': '8:1' }, nextMounts = mounts, start = '10', finish = '11.25' } = {}) {
    const prefix = path.join(os.tmpdir(), 'tabby-disk-io-')
    const root = fs.mkdtempSync(prefix)
    const file = (name, data) => { const target = path.join(root, name); fs.writeFileSync(target, data); return target.replace(/\\/g, '/') }
    const map = entries => Object.entries(entries).map(([mount, device]) => `${mount}\t${device}`).join('\n') + '\n'
    const env = {
        IO_TEST_DISKS: file('disks', before.join('\n') + '\n'), IO_TEST_NEXT_DISKS: file('next-disks', after.join('\n') + '\n'),
        IO_TEST_UPTIME: file('uptime', start + ' 0\n'), IO_TEST_NEXT_UPTIME: file('next-uptime', finish + ' 0\n'),
        IO_TEST_MOUNTS: file('mounts', map(mounts)), IO_TEST_NEXT_MOUNTS: file('next-mounts', map(nextMounts)),
    }
    const mock = `findmnt() {
    [ "$1" = -rn ] && [ "$2" = -o ] && [ "$3" = MAJ:MIN ] && [ "$4" = --mountpoint ] || return 1
    awk -F '\t' -v mount="$5" '$1==mount {print $2; found=1} END {if(!found) exit 1}' "$IO_TEST_MOUNTS"
}
sleep() { cp "$IO_TEST_NEXT_DISKS" "$IO_TEST_DISKS"; cp "$IO_TEST_NEXT_UPTIME" "$IO_TEST_UPTIME"; cp "$IO_TEST_NEXT_MOUNTS" "$IO_TEST_MOUNTS"; }
`
    const source = command.replaceAll('/proc/diskstats', '"$IO_TEST_DISKS"').replaceAll('/proc/uptime', '"$IO_TEST_UPTIME"')
    try {
        // Expanded-mount fixtures spawn many mocked findmnt/awk processes on
        // Windows; allow process-start overhead when the full suite runs in parallel.
        const result = spawnSync(shell, ['-s'], { input: mock + '\n' + source + '\n', encoding: 'utf8', timeout: 15000,
            env: { ...process.env, PATH: shellTools + process.env.PATH, ...env } })
        if (result.error) throw result.error
        return result
    } finally {
        if (!path.resolve(root).startsWith(path.resolve(prefix))) throw Error('Unexpected fixture path')
        fs.rmSync(root, { recursive: true, force: true })
    }
}

function assertNormalized(result, expectedRaw, expectedPercent) {
    assert.equal(result.status, 0, result.stderr)
    const [tag, raw, percent] = result.stdout.trim().split(':')
    assert.equal(tag, 'TABBY-IO')
    assert.equal(raw, expectedRaw)
    assert.match(percent, /^\d+\.\d+$/)
    assert(Math.abs(Number(percent) - expectedPercent) < 1e-7, `${percent} vs ${expectedPercent}`)
    return Number(percent)
}

test('short disk checks preserve validation and migrate only exact generated scripts', () => {
    const paths = ['/', '/data2'];
    const legacy = createDiskIoCommand(paths).split('\nio_before=')[0] + '\ntabby_io_snapshot >/dev/null';
    const compact = createDiskIoCheckCommand(paths);
    assert(compact.length < legacy.length * .65);
    assert.equal(compactDiskIoCheck(legacy), compact);
    assert.equal(compactDiskIoCheck(legacy + '\n# custom'), legacy + '\n# custom');
    assert.equal(compactDiskIoCheck('echo user-command'), 'echo user-command');
    for (const options of [{}, { mounts: {} }, { before: [row().replace('2048', 'broken')] },
        { mounts: { '/': '8:1', '/data2': '8:1' } }, { mounts: { '/data2': '8:2' }, before: [row('8:2')] }]) {
        assert.equal(run(compact, options).status, run(legacy, options).status);
    }
    const conf = { customMetrics: [{ checkCommand: 'printf custom' }], metricGroups: [{ enabled: false,
        main: { checkCommand: legacy }, children: [{ checkCommand: legacy }] }] };
    assert(migrateDiskIoChecks(conf));
    assert.equal(conf.customMetrics[0].checkCommand, 'printf custom');
    assert.equal(conf.metricGroups[0].children[0].checkCommand, compact);
    assert(!migrateDiskIoChecks(conf), 'Migration is idempotent');
});

test('disk I/O computes rate, request-weighted await and queue from actual elapsed time', () => {
    const options = { after: [row('8:1', [110, 4096, 1050, 220, 8192, 2200, 5500])] }
    const value = run(createDiskIoCommand(['/']), options)
    assert.equal(value.status, 0, value.stderr)
    assert.equal(value.stdout.trim(), '2.40')
    assert.equal(run(createDiskIoCommand(['/'], true), options).stdout.trim(), 'R 0.80 / W 1.60 MB/s | await 8.3 ms | queue 0.40')
})

test('reference-normalized I/O retains raw throughput and converts decimal manufacturer MB/s', () => {
    const options = { after: [row('8:1', [110, 4096, 1050, 220, 8192, 2200, 5500])] }
    const command = createDiskIoCommand(['/'], false, { '/': 100 })
    const actual = run(command, options)
    assertNormalized(actual, '2.40', 2.4 * 1.048576)
    assertNormalized(run(command), '0.00', 0)
    assert.equal(createDiskIoCommand(['/'], true, { '/': 100 }), createDiskIoCommand(['/'], true), 'Detail output and sampling remain unchanged')
    assert.equal(run(createDiskIoCommand(['/']), options).stdout.trim(), '2.40', 'Existing presets keep the plain numeric protocol')
})

test('normalized totals deduplicate aliases using the smallest per-device reference', () => {
    const options = { mounts: { '/': '253:0', '/alias': '253:0', '/data': '259:1' },
        before: [row('253:0'), row('259:1')],
        after: [row('253:0', [110, 4096, 1050, 220, 8192, 2200, 5500]), row('259:1', [110, 4096, 1050, 220, 8192, 2200, 5500])],
    }
    const references = { '/': 100, '/alias': 50, '/data': 200 }
    for (const paths of [['/', '/alias', '/data'], ['/alias', '/data', '/']]) {
        const result = run(createDiskIoCommand(paths, false, references), options)
        assertNormalized(result, '4.80', 100 * 4.8 / (250 / 1.048576))
    }
})

test('unmounted candidates and unsupported filesystems never dilute normalized I/O', () => {
    const paths = ['/', ...Array.from({ length: 12 }, (_, i) => `/data${i + 1}`), '/overlay', '/nfs']
    const references = Object.fromEntries(paths.map(mount => [mount, mount === '/' ? 100 : 10000]))
    const result = run(createDiskIoCommand(paths, false, references), {
        mounts: { '/': '8:1', '/overlay': '0:123', '/nfs': '0:88' },
        after: [row('8:1', [110, 4096, 1050, 220, 8192, 2200, 5500])],
    })
    assertNormalized(result, '2.40', 2.4 * 1.048576)
    const unsupported = run(createDiskIoCommand(['/overlay'], false, { '/overlay': 100 }), { mounts: { '/overlay': '0:123' } })
    assert.notEqual(unsupported.status, 0)
    assert.equal(unsupported.stdout, '')
})

test('normalized sampling rejects removed devices and path remapping even when the device set is unchanged', () => {
    const command = createDiskIoCommand(['/', '/data'], false, { '/': 100, '/data': 200 })
    for (const nextMounts of [{ '/': '8:2', '/data': '8:1' }, { '/': '8:1' }, { '/': '8:3', '/data': '8:2' }]) {
        const result = run(command, { mounts: { '/': '8:1', '/data': '8:2' }, nextMounts,
            before: [row('8:1'), row('8:2'), row('8:3')],
        })
        assert.notEqual(result.status, 0, JSON.stringify(nextMounts))
        assert.equal(result.stdout, '')
    }
})

test('reference maps require explicit positive finite numbers for every requested mount', () => {
    for (const reference of [0, -1, NaN, Infinity, -Infinity, undefined, null, '100']) {
        assert.throws(() => createDiskIoCommand(['/'], false, { '/': reference }), /positive finite/)
    }
    assert.throws(() => createDiskIoCommand(['/', '/missing'], false, { '/': 100 }), /positive finite/)
    assert.throws(() => createDiskIoCommand(['/'], true, {}), /positive finite/)
    assert.throws(() => createDiskIoCommand(['/', 'relative'], false, { '/': 100, relative: 100 }), /positive finite/)
    assert.throws(() => createDiskIoCommand(['/'], false, Object.create({ '/': 100 })), /positive finite/)
    const mount = `/data/a'$(printf INJECTED >&2); space`
    const safe = run(createDiskIoCommand([mount], false, { [mount]: 100 }), { mounts: { [mount]: '8:1' } })
    assertNormalized(safe, '0.00', 0)
    assert.doesNotMatch(safe.stderr, /INJECTED/)
})

test('normalized percentages preserve values just below color thresholds independently of rounded MB/s', () => {
    for (const [percent, threshold] of [[79.999, 80], [94.999, 95]]) {
        const readSectors = Math.round(percent / 100 * 2048 * 100000)
        const result = run(createDiskIoCommand(['/'], false, { '/': 1.048576 }), {
            after: [row('8:1', [110, 2048 + readSectors, 1050, 200, 4096, 2000, 5500])],
            start: '10', finish: '100010',
        })
        const actual = assertNormalized(result, (percent / 100).toFixed(2), percent)
        assert(actual < threshold, `A true ${percent}% must stay below ${threshold}%`)
    }
    for (const reference of [215, 255, 7000]) for (const percent of [80, 95]) {
        // A 32-second synthetic sample gives an integral sector count at either threshold.
        const readSectors = reference * 625 * percent
        const result = run(createDiskIoCommand(['/'], false, { '/': reference }), {
            after: [row('8:1', [110, 2048 + readSectors, 1050, 200, 4096, 2000, 5500])],
            start: '10', finish: '42',
        })
        const actual = assertNormalized(result, (reference / 1.048576 * percent / 100).toFixed(2), percent)
        assert.equal(actual, percent, `${reference} MB/s reference reaches the exact ${percent}% boundary`)
    }
})

test('totals deduplicate exact mounted block IDs, including bind mounts and LVM aliases', () => {
    const options = { mounts: { '/': '253:0', '/alias': '253:0', '/data': '259:1' },
        before: [row('253:0'), row('259:1')],
        after: [row('253:0', [110, 4096, 1050, 220, 8192, 2200, 5500]), row('259:1', [110, 4096, 1050, 220, 8192, 2200, 5500])],
    }
    assert.equal(run(createDiskIoCommand(['/', '/alias', '/data']), options).stdout.trim(), '4.80')
    assert.equal(run(createDiskIoCommand(['/', '/alias', '/data'], true), options).stdout.trim(), 'R 1.60 / W 3.20 MB/s | await 8.3 ms | queue 0.80')
})

test('unsupported overlay/network mounts and absent data mounts never fall back to root', () => {
    for (const mounts of [{ '/': '8:1' }, { '/overlay': '0:123' }, { '/nfs': '0:88' }]) {
        const mount = Object.keys(mounts).find(name => name !== '/') || '/data'
        for (const command of [createDiskIoCheckCommand([mount]), createDiskIoCommand([mount])]) {
            const result = run(command, { mounts })
            assert.notEqual(result.status, 0)
            assert.equal(result.stdout, '')
        }
    }
    assert.equal(run(createDiskIoCheckCommand(['/', '/missing', '/nfs']), { mounts: { '/': '8:1', '/nfs': '0:88' } }).status, 0)
})

test('an idle device has zero throughput but no fabricated latency measurement', () => {
    assert.equal(run(createDiskIoCommand(['/'])).stdout.trim(), '0.00')
    assert.equal(run(createDiskIoCommand(['/'], true)).stdout.trim(), 'R 0.00 / W 0.00 MB/s | await - | queue 0.00')
})

test('invalid counters, resets, removed/remapped devices and bad clocks fail without bogus output', () => {
    for (const options of [
        { before: [row('8:1', ['bad', 2, 3, 4, 5, 6, 7])] },
        { after: [row('8:1', [99, 2048, 1000, 200, 4096, 2000, 5000])] },
        { after: [] }, { after: ['8 1 disk 10'] },
        { start: '10', finish: '10' }, { start: '20', finish: '10' }, { start: 'bad' },
        { nextMounts: {} }, { nextMounts: { '/': '8:2' }, before: [row(), row('8:2')] },
    ]) {
        const result = run(createDiskIoCommand(['/'], true), options)
        assert.notEqual(result.status, 0, JSON.stringify(options))
        assert.equal(result.stdout, '', JSON.stringify(options))
    }
})

test('mount paths remain shell-quoted and exact, including punctuation and whitespace', () => {
    const mount = `/data/a'$(printf INJECTED >&2); space`
    const result = run(createDiskIoCommand([mount]), { mounts: { [mount]: '8:1' } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), '0.00')
    assert.doesNotMatch(result.stderr, /INJECTED/)
    assert.throws(() => createDiskIoCommand([]))
    assert.throws(() => createDiskIoCommand(['relative']))
})

test('six lab I/O groups mirror current capacity mount bindings and stay safely scoped', () => {
    const bundled = getBundledPresets()
    const disks = bundled.filter(entry => entry.id.startsWith('disks-') && !entry.id.endsWith('-used') && entry.audience === 'author-lab')
    assert.equal(disks.length, 6)
    for (const disk of disks) {
        const expected = createDiskIoGroupPreset(disk)
        const actual = bundled.find(entry => entry.id === expected.id)
        assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)))
        assert.equal(actual.audience, 'author-lab')
        assert.match(actual.descriptions.zh, /其他人请勿下载/)
        assert.match(actual.descriptions.en, /laboratory only/)
        assert.deepEqual(actual.profileNames, disk.profileNames)
        assert.equal(actual.group.children.length, disk.group.children.length)
        const missing = instantiatePreset(actual, [])
        assert.equal(missing.metricGroups[0].displayScope.mode, 'selected')
        assert.equal(missing.metricGroups[0].displayScope.profileIds.length, 0)
        for (const metric of [actual.group.main, ...actual.group.children]) {
            assert.equal(metric.type, 'text')
            assert.equal(metric.interval, 30)
            assert.equal(metric.timeout, 15)
            const capacityMetric = metric === actual.group.main ? disk.group.main : disk.group.children.find(child => child.label === metric.label)
            assert.equal(metric.visibleWhenUnavailable, capacityMetric.visibleWhenUnavailable)
            assert.equal(metric.showWhenUnavailable, capacityMetric.showWhenUnavailable)
            assert.equal(metric.suffix, ' MB/s')
            assert.equal(metric.valueFormat, 'disk-io-rate')
            assert.deepEqual(metric.colorRules, [
                { operator: '>=', value: '95', color: '#ff0000' },
                { operator: '>=', value: '80', color: '#ffa500' },
            ])
            assert.doesNotMatch(metric.command, /\b(?:iostat|fio|dd|sudo|mktemp|nvidia-smi)\b/)
        }
    }
    const p3 = bundled.find(entry => entry.id === 'disk-io-P3磁盘')
    assert.deepEqual(p3.group.children.map(metric => metric.label), ['系统盘', '/data', '/data2', '/data3', '/data4'])
})

test('factory references follow confirmed P3 devices and documented SSD/HDD assumptions while preserving MB/s readings', () => {
    const bundled = getBundledPresets()
    assert.equal(bundled.length, 37)
    const examples = [
        ['P0磁盘', '/', 500], ['P0磁盘', '/data', 180], ['P0磁盘', '/data4', 180],
        ['P3磁盘', '/', 7000], ['P3磁盘', '/data', 215], ['P3磁盘', '/data2', 255], ['P3磁盘', '/data3', 180],
        ['P1容器磁盘', '/public', 7000], ['P2磁盘', '/data', 180], ['P4磁盘', '/data12', 180], ['NAS磁盘', '/volume4', 180],
    ]
    for (const [name, mount, reference] of examples) {
        const preset = createDiskIoGroupPreset(bundled.find(entry => entry.id === `disks-${name}`))
        const metric = preset.group.children.find(child => child.label === (mount === '/' ? '系统盘' : mount))
        const sample = { mounts: { [mount]: '8:1' }, after: [row('8:1', [110, 4096, 1050, 220, 8192, 2200, 5500])] }
        const result = run(metric.command, sample)
        assert.equal(result.status, 0, `${name} ${mount}: ${result.stderr}`)
        const [tag, raw, percent] = result.stdout.trim().split(':')
        assert.equal(tag, 'TABBY-IO')
        assert.equal(raw, '2.40', `${name} ${mount}: displayed throughput remains base-1024 MB/s`)
        const expectedPercent = 100 * 2.4 / (reference / 1.048576)
        assert(Math.abs(Number(percent) - expectedPercent) < 1e-7, `${name} ${mount}: ${percent} vs ${expectedPercent}`)
        assert.equal(metric.suffix, ' MB/s')
        assert.equal(metric.valueFormat, 'disk-io-rate')
    }
})

test('factory totals include only mounted readable disks, with device-specific references and optional candidates excluded', () => {
    const bundled = getBundledPresets()
    for (const [name, paths, referenceTotal] of [
        ['P3磁盘', ['/data', '/data2'], 215 + 255],
        ['P4磁盘', ['/data'], 180],
    ]) {
        const preset = createDiskIoGroupPreset(bundled.find(entry => entry.id === `disks-${name}`))
        const devices = paths.map((_, index) => `8:${index + 1}`)
        const result = run(preset.group.main.command, {
            mounts: Object.fromEntries(paths.map((mount, index) => [mount, devices[index]])),
            before: devices.map(device => row(device)),
            after: devices.map(device => row(device, [110, 4096, 1050, 220, 8192, 2200, 5500])),
        })
        assert.equal(result.status, 0, result.stderr)
        const [tag, raw, percent] = result.stdout.trim().split(':')
        assert.equal(tag, 'TABBY-IO')
        assert.equal(raw, (2.4 * paths.length).toFixed(2))
        assert(Math.abs(Number(percent) - 100 * 2.4 * paths.length / (referenceTotal / 1.048576)) < 1e-7)
    }
})

test('NAS I/O keeps four optional volumes, exact personal binding and no laboratory notice', () => {
    const bundled = getBundledPresets()
    const capacity = bundled.find(entry => entry.id === 'disks-NAS磁盘')
    const preset = bundled.find(entry => entry.id === 'disk-io-NAS磁盘')
    assert.deepEqual(preset, JSON.parse(JSON.stringify(createDiskIoGroupPreset(capacity))))
    assert.deepEqual(preset.group.children.map(metric => metric.label), ['系统盘', '/volume1', '/volume2', '/volume3', '/volume4'])
    assert.deepEqual(preset.profileNames, ['NAS'])
    assert.equal(preset.audience, undefined)
    assert.doesNotMatch(preset.descriptions.zh, /实验室自用/)
    assert.doesNotMatch(preset.descriptions.en, /laboratory only/)
    assert.equal(preset.group.children[0].visibleWhenUnavailable, true)
    for (const child of preset.group.children.slice(1)) {
        assert.equal(child.visibleWhenUnavailable, false)
        assert.equal(child.showWhenUnavailable, false)
        assert.notEqual(run(child.checkCommand, { mounts: {} }).status, 0)
        assert.equal(run(child.checkCommand, { mounts: { [child.label]: '8:1' } }).status, 0)
    }
    assert.deepEqual(instantiatePreset(preset, [{ id: 'personal-nas', name: 'NAS' }]).metricGroups[0].displayScope.profileIds, ['personal-nas'])
    assert.deepEqual(instantiatePreset(preset, []).metricGroups[0].displayScope.profileIds, [])
})

test('capacity and GPU presets use reduced collection frequency', () => {
    for (const preset of getBundledPresets()) {
        if (preset.id.startsWith('disks-')) for (const metric of [preset.group.main, ...preset.group.children]) assert.equal(metric.interval, 60)
        if (preset.id === 'gpu-memory-group') for (const metric of [preset.group.main, ...preset.group.children]) assert.equal(metric.interval, 30)
        if (preset.id === 'single-gpu-memory') assert.equal(preset.metric.interval, 30)
    }
})
