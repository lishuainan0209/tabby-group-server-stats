const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const preset = JSON.parse(fs.readFileSync(path.join(__dirname, '../presets.json'), 'utf8')).find(item => item.id === 'single-users')
const metric = preset.metric
const gitExecPath = process.platform === 'win32' ? spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() : ''
const gitShell = gitExecPath ? path.resolve(gitExecPath, '../../..', 'bin/sh.exe') : ''
const shell = process.env.TEST_SH || (process.platform === 'win32' ? [gitShell, 'C:\\Program Files\\Git\\bin\\sh.exe', 'S:\\Git\\bin\\sh.exe'].find(file => file && fs.existsSync(file)) : '/bin/sh')
if (!shell) throw new Error('Install Git for Windows or set TEST_SH to its sh.exe')
const shellTools = process.platform === 'win32' ? path.resolve(path.dirname(shell), '../usr/bin') + path.delimiter : ''
function run(command, records = '', setup = '') {
    const result = spawnSync(shell, ['-s'], {
        input: `who() { printf '%s\\n' "$WHO_RECORDS"; }\n${setup}\n${command}\n`,
        encoding: 'utf8', timeout: 4000,
        env: { ...process.env, PATH: shellTools + process.env.PATH, WHO_RECORDS: records, USER: 'current-connection-user', LOGNAME: 'current-connection-user' }
    })
    if (result.error) throw result.error
    return result
}

test('login count includes tty, pts and console records and details aggregate all users deterministically', () => {
    const records = [
        'bob      pts/1        2026-11-06 10:20 (host-b)',
        'alice    tty1         2026-11-06 09:10',
        'alice    pts/0        2026-11-06 10:00 (host-a)',
        'carol    console      Nov  6 08:50',
        'bob      ttys001      Nov  6 11:00',
        ''
    ].join('\n')
    const count = run(metric.command, records)
    const detail = run(metric.detailCommand, records)
    assert.equal(count.status, 0, count.stderr)
    assert.equal(count.stdout.trim(), '5')
    assert.equal(detail.status, 0, detail.stderr)
    assert.equal(detail.stdout.trim(), 'alice ×2, bob ×2, carol ×1')
    assert.doesNotMatch(detail.stdout, /current-connection-user/)
    assert.equal(run(metric.detailCommand, records.split('\n').reverse().join('\n')).stdout, detail.stdout)
})

test('empty or whitespace-only login records display zero and a dash without an error', () => {
    for (const records of ['', '\n\n', '  \n\t\n']) {
        const count = run(metric.command, records)
        const detail = run(metric.detailCommand, records)
        assert.equal(count.status, 0)
        assert.equal(count.stdout.trim(), '0')
        assert.equal(detail.status, 0)
        assert.equal(detail.stdout.trim(), '-')
    }
})

test('missing who fails the object check and a failed who query cannot look like zero users', () => {
    assert.equal(metric.checkMode, 'exitCode')
    assert.equal(metric.checkExpected, '0')
    assert.equal(run(metric.checkCommand).status, 0)
    assert.notEqual(run(metric.checkCommand, '', 'unset -f who; PATH=/definitely-no-executables').status, 0)
    for (const command of [metric.command, metric.detailCommand]) {
        for (const failure of [1, 9, 127]) {
            const result = run(command, 'alice pts/0 2026-11-06 10:00', `who() { printf '%s\\n' "$WHO_RECORDS"; return ${failure}; }`)
            assert.notEqual(result.status, 0)
            assert.equal(result.stdout, '')
        }
    }
})

test('aggregation and sorting failures remain command errors instead of an empty login list', () => {
    const records = 'alice pts/0 2026-11-06 10:00'
    for (const command of [metric.command, metric.detailCommand]) {
        const failedAwk = run(command, records, 'awk() { return 2; }')
        assert.notEqual(failedAwk.status, 0)
        assert.equal(failedAwk.stdout, '')
    }
    const failedSort = run(metric.detailCommand, records, 'sort() { return 2; }')
    assert.notEqual(failedSort.status, 0)
    assert.equal(failedSort.stdout, '')
})

test('the shipped bilingual description explains the system-session scope and preserves the main display type', () => {
    assert.equal(metric.type, 'text')
    assert.equal(metric.suffix, '')
    assert.equal(metric.interval, 30)
    assert.equal(metric.icon, 'users')
    assert.match(preset.descriptions.en, /recorded by the system/)
    assert.match(preset.descriptions.en, /not a count of all TCP or background SSH/)
    assert.match(preset.descriptions.zh, /系统记录/)
    assert.match(preset.descriptions.zh, /不等同于全部 TCP 或后台 SSH/)
    for (const command of [metric.command, metric.detailCommand]) {
        assert.equal((command.match(/LC_ALL=C who /g) || []).length, 1)
        assert.doesNotMatch(command, /whoami|\$USER|\$LOGNAME|grep -c pts/)
    }
})
