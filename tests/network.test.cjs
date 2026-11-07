const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename)
const { createNetworkRateCommand, createNetworkDetailCommand, getBuiltinDefaults } = require('../src/builtin-metrics.ts')
const colorApi = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/config.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true }
}).outputText, { exports: colorApi, require: name => {
    if (name === '@angular/core') return { Injectable: () => () => {} }
    if (name === 'tabby-core') return { ConfigProvider: class {} }
    return {}
} })
const { evaluateColor } = colorApi
const gitExecPath = process.platform === 'win32' ? spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() : ''
const gitShell = gitExecPath ? path.resolve(gitExecPath, '../../..', 'bin/sh.exe') : ''
const shell = process.env.TEST_SH || (process.platform === 'win32' ? [gitShell, 'C:\\Program Files\\Git\\bin\\sh.exe', 'S:\\Git\\bin\\sh.exe'].find(file => file && fs.existsSync(file)) : '/bin/sh')
if (!shell) throw Error('Install Git for Windows or set TEST_SH to its sh.exe')
const shellTools = process.platform === 'win32' ? path.resolve(path.dirname(shell), '../usr/bin') + path.delimiter : ''
function run(command, mock, env = {}) {
    const result = spawnSync(shell, ['-s'], { input: mock + '\n' + command + '\n', encoding: 'utf8', timeout: 5000,
        env: { ...process.env, PATH: shellTools + process.env.PATH, ...env } })
    if (result.error) throw result.error
    return result
}
const table = rows => 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n' + rows.map(([name, rx, tx]) => ` ${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`).join('\n') + '\n'
const route4 = names => 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n' + names.map(name => `${name} 00000000 01000000 0003 0 0 100 00000000 0 0 0`).join('\n') + '\n'
const route6 = names => names.map(name => `00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000064 00000000 00000000 00000003 ${name}`).join('\n') + '\n'
const gib = 1073741824
function linux(command, { before = [['eth0', 1024, 2048]], after = before, ipv4 = ['eth0'], ipv6 = [], start = '100.25', finish = '101.50', sys = {} } = {}) {
    const prefix = path.join(os.tmpdir(), 'tabby-network-')
    const root = fs.mkdtempSync(prefix)
    const file = (name, text) => { const target = path.join(root, name); fs.writeFileSync(target, text); return target.replace(/\\/g, '/') }
    const env = {
        NET_TEST_DEV: file('dev', table(before)), NET_TEST_NEXT_DEV: file('next-dev', table(after)),
        NET_TEST_ROUTE4: file('route', route4(ipv4)), NET_TEST_ROUTE6: file('route6', route6(ipv6)),
        NET_TEST_TIME: file('uptime', start + ' 0\n'), NET_TEST_NEXT_TIME: file('next-uptime', finish + ' 0\n'),
        NET_TEST_SYS: path.join(root, 'sys').replace(/\\/g, '/'),
    }
    for (const [name, flags] of Object.entries(sys)) {
        const folder = path.join(root, 'sys', name)
        fs.mkdirSync(folder, { recursive: true })
        if (flags.master) fs.writeFileSync(path.join(folder, 'master'), '')
        if (flags.state) fs.writeFileSync(path.join(folder, 'operstate'), flags.state + '\n')
    }
    const source = command.replaceAll('/proc/net/dev', '"$NET_TEST_DEV"').replaceAll('/proc/net/route', '"$NET_TEST_ROUTE4"')
        .replaceAll('/proc/net/ipv6_route', '"$NET_TEST_ROUTE6"').replaceAll('/proc/uptime', '"$NET_TEST_TIME"').replaceAll('/sys/class/net', '$NET_TEST_SYS')
    try {
        return run(source, `uname() { printf 'Linux\\n'; }
sleep() { cp "$NET_TEST_NEXT_DEV" "$NET_TEST_DEV"; cp "$NET_TEST_NEXT_TIME" "$NET_TEST_TIME"; }`, env)
    } finally {
        if (!path.resolve(root).startsWith(path.resolve(prefix))) throw Error('Unexpected fixture path')
        fs.rmSync(root, { recursive: true, force: true })
    }
}

test('Linux counts default IPv4/IPv6 route interfaces once and excludes duplicate virtual traffic', () => {
    const before = [['lo', 10 * gib, 10 * gib], ['eth0', 2 * gib, 3 * gib], ['eth1', gib, 2 * gib], ['veth0', 20 * gib, 20 * gib]]
    const after = before.map(([name, rx, tx]) => [name, rx + (name === 'eth0' || name === 'eth1' ? 1024 : 900000), tx + (name === 'eth0' ? 2048 : name === 'eth1' ? 4096 : 900000)])
    const options = { before, after, ipv4: ['eth0', 'eth0', 'eth1'], ipv6: ['eth0'], start: '100.25', finish: '101.50' }
    assert.equal(linux(createNetworkRateCommand('rx'), options).stdout.trim(), '1.60')
    assert.equal(linux(createNetworkRateCommand('tx'), options).stdout.trim(), '4.80')
    assert.equal(linux(createNetworkRateCommand('total'), options).stdout.trim(), '6.40')
    assert.equal(linux(createNetworkDetailCommand('rx'), options).stdout.trim(), 'Received total: 3.000 GB (since interface reset; eth0,eth1)')
    assert.equal(linux(createNetworkDetailCommand('tx'), options).stdout.trim(), 'Sent total: 5.000 GB (since interface reset; eth0,eth1)')
    assert.equal(linux(createNetworkDetailCommand('total'), options).stdout.trim(), 'Combined total: 8.000 GB (since interface reset; eth0,eth1)')
})

test('Linux IPv6-only defaults and containers without sysfs or physical NICs remain usable', () => {
    assert.equal(linux(createNetworkRateCommand('rx'), {
        before: [['eth0', 100, 200]], after: [['eth0', 101, 200]], ipv4: [], ipv6: ['eth0'], start: '10', finish: '11',
    }).stdout.trim(), '0.000977')
    const result = linux(createNetworkDetailCommand('rx'), { before: [['eth0', gib, 200]], ipv4: [], ipv6: [] })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'Received total: 1.000 GB (since interface reset; eth0)')
})

test('Linux no-route fallback excludes loopback, slave interfaces and interfaces that are down', () => {
    const result = linux(createNetworkDetailCommand('rx'), {
        before: [['lo', 9 * gib, 0], ['br0', gib, 0], ['eth0', gib, 0], ['eth1', gib, 0]], ipv4: [], ipv6: [],
        sys: { br0: { state: 'up' }, eth0: { master: true, state: 'up' }, eth1: { state: 'down' } },
    })
    assert.equal(result.stdout.trim(), 'Received total: 1.000 GB (since interface reset; br0)')
})

test('counter resets are clamped per interface without hiding other interface traffic', () => {
    const result = linux(createNetworkRateCommand('total'), {
        before: [['eth0', 10000, 10000], ['eth1', 10000, 10000]],
        after: [['eth0', 0, 10000], ['eth1', 12048, 11024]], ipv4: ['eth0', 'eth1'], start: '10', finish: '11',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), '3.00')
})

test('missing interfaces, malformed counters and invalid elapsed time fail instead of producing zero', () => {
    for (const options of [
        { before: [] }, { after: [] }, { after: [['eth0', 'invalid', 2000]] },
        { start: '10', finish: '10' }, { start: '11', finish: '10' }, { finish: 'invalid' },
    ]) {
        const result = linux(createNetworkRateCommand('rx'), options)
        assert.notEqual(result.status, 0, JSON.stringify(options))
        assert.equal(result.stdout, '', JSON.stringify(options))
    }
})

const macTable = (rx, tx) => `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
lo0 16384 <Link#1> 1 0 99999999 1 0 99999999 0
en0 1500 <Link#4> aa:bb:cc:dd:ee:ff 1 0 ${rx} 1 0 ${tx} 0
en0 1500 192.0.2.0 192.0.2.5 1 0 ${rx} 1 0 ${tx} 0
en0 1500 fe80:: fe80::1%en0 1 0 ${rx} 1 0 ${tx} 0
utun0 1500 <Link#5> 1 0 9000000 1 0 9000000 0
en2* 1500 <Link#6> aa:bb:cc:dd:ee:00 1 0 9000000 1 0 9000000 0`
const macMock = `net_stage=0
uname() { printf 'Darwin\\n'; }
route() { [ "$NO_ROUTE" = 1 ] && return 1; printf '  interface: en0\\n'; }
netstat() { [ "$NETSTAT_FAIL" = 1 ] && return 1; if [ "$net_stage" = 1 ]; then printf '%s\\n' "$MAC_AFTER"; else printf '%s\\n' "$MAC_BEFORE"; fi; }
sleep() { net_stage=1; }
perl() { [ "$PERL_FAIL" = 1 ] && return 1; if [ "$net_stage" = 1 ]; then printf '%s\\n' "$MAC_FINISH"; else printf '%s\\n' "$MAC_START"; fi; }
date() { if [ "$net_stage" = 1 ]; then printf '%s\\n' "$MAC_FINISH"; else printf '%s\\n' "$MAC_START"; fi; }`
const macEnv = { MAC_BEFORE: macTable(gib, 2 * gib), MAC_AFTER: macTable(gib + 1024, 2 * gib + 2048), MAC_START: '100.25', MAC_FINISH: '101.50' }

test('macOS reads named byte columns once per link, excluding address aliases and loopback', () => {
    assert.equal(run(createNetworkRateCommand('rx'), macMock, macEnv).stdout.trim(), '0.800000')
    assert.equal(run(createNetworkRateCommand('tx'), macMock, macEnv).stdout.trim(), '1.60')
    assert.equal(run(createNetworkDetailCommand('rx'), macMock, macEnv).stdout.trim(), 'Received total: 1.000 GB (since interface reset; en0)')
    assert.equal(run(createNetworkDetailCommand('tx'), macMock, macEnv).stdout.trim(), 'Sent total: 2.000 GB (since interface reset; en0)')
})

test('macOS supports low rates, resets, missing high-resolution clock and no-route fallback', () => {
    assert.equal(run(createNetworkRateCommand('rx'), macMock, { ...macEnv, MAC_AFTER: macTable(gib + 1, 0), MAC_START: '10', MAC_FINISH: '11', PERL_FAIL: '1' }).stdout.trim(), '0.000977')
    assert.equal(run(createNetworkRateCommand('rx'), macMock, { ...macEnv, MAC_AFTER: macTable(10, 20) }).stdout.trim(), '0')
    const fallback = run(createNetworkDetailCommand('rx'), macMock, { ...macEnv, NO_ROUTE: '1' })
    assert.equal(fallback.status, 0, fallback.stderr)
    assert.match(fallback.stdout, /since interface reset; en0,utun0\)/)
    for (const extra of [{ NETSTAT_FAIL: '1' }, { MAC_AFTER: 'bad data' }, { MAC_FINISH: '100.25' }, { MAC_FINISH: 'bad' }]) {
        const failed = run(createNetworkRateCommand('rx'), macMock, { ...macEnv, ...extra })
        assert.notEqual(failed.status, 0)
        assert.equal(failed.stdout, '')
    }
})

test('network factory keeps direction-specific details and memory thresholds use strict boundaries', () => {
    const defaults = getBuiltinDefaults()
    assert.match(defaults.net.children[0].detailCommand, /Received total:/)
    assert.match(defaults.net.children[1].detailCommand, /Sent total:/)
    assert.doesNotMatch(defaults.net.children[0].detailCommand, /Sent total:/)
    assert.doesNotMatch(defaults.net.children[1].detailCommand, /Received total:/)
    assert.equal(run(defaults.net.children[0].checkCommand, macMock, macEnv).status, 0)
    for (const metric of [defaults.cpu, defaults.ram, defaults.disk, defaults.net.main, ...defaults.net.children]) assert.equal(metric.color, '#00ff00')
    for (const [value, color] of [[60, '#00ff00'], [60.01, '#ffa500'], [80, '#ffa500'], [80.01, '#ff0000']]) {
        assert.equal(evaluateColor(String(value), defaults.ram.colorRules, defaults.ram.color), color)
    }
})
