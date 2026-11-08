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
const { createDiskIoCommand, createDiskIoCheckCommand } = require('../src/disk-io.ts')
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
        const result = spawnSync(shell, ['-s'], { input: mock + '\n' + source + '\n', encoding: 'utf8', timeout: 5000,
            env: { ...process.env, PATH: shellTools + process.env.PATH, ...env } })
        if (result.error) throw result.error
        return result
    } finally {
        if (!path.resolve(root).startsWith(path.resolve(prefix))) throw Error('Unexpected fixture path')
        fs.rmSync(root, { recursive: true, force: true })
    }
}

test('disk I/O computes rate, request-weighted await and queue from actual elapsed time', () => {
    const options = { after: [row('8:1', [110, 4096, 1050, 220, 8192, 2200, 5500])] }
    const value = run(createDiskIoCommand(['/']), options)
    assert.equal(value.status, 0, value.stderr)
    assert.equal(value.stdout.trim(), '2.40')
    assert.equal(run(createDiskIoCommand(['/'], true), options).stdout.trim(), 'R 0.80 / W 1.60 MB/s | await 8.3 ms | queue 0.40')
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
            assert.equal(metric.visibleWhenUnavailable, true)
            assert.equal(metric.suffix, ' MB/s')
            assert.doesNotMatch(metric.command, /\b(?:iostat|fio|dd|sudo|mktemp|nvidia-smi)\b/)
        }
    }
    const p3 = bundled.find(entry => entry.id === 'disk-io-P3磁盘')
    assert.deepEqual(p3.group.children.map(metric => metric.label), ['系统盘', '/data', '/data2'])
})

test('capacity and GPU presets use reduced collection frequency', () => {
    for (const preset of getBundledPresets()) {
        if (preset.id.startsWith('disks-')) for (const metric of [preset.group.main, ...preset.group.children]) assert.equal(metric.interval, 60)
        if (preset.id === 'gpu-memory-group') for (const metric of [preset.group.main, ...preset.group.children]) assert.equal(metric.interval, 30)
        if (preset.id === 'single-gpu-memory') assert.equal(preset.metric.interval, 30)
    }
})
