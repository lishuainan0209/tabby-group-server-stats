const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { spawn, spawnSync } = require('node:child_process')
const { Subject } = require('rxjs')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017, experimentalDecorators: true }
}).outputText, filename)
const originalLoad = Module._load
Module._load = function (name, parent, isMain) {
    if (name === '@angular/core') return { Injectable: () => type => type }
    if (name === 'tabby-core') return {}
    if (name === './metric-scope.service') return {}
    return originalLoad.call(this, name, parent, isMain)
}
const { StatsService } = require('../src/services/stats.service.ts')
const { parseMetricResults, shellQuote } = require('../src/metric-model.ts')
const gitExecPath = process.platform === 'win32' ? spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() : ''
const gitShell = gitExecPath ? path.resolve(gitExecPath, '../../..', 'bin/sh.exe') : ''
const shell = process.env.TEST_SH || (process.platform === 'win32' ? [gitShell, 'C:\\Program Files\\Git\\bin\\sh.exe', 'S:\\Git\\bin\\sh.exe'].find(file => file && fs.existsSync(file)) : '/bin/sh')
if (!shell) throw new Error('Install Git for Windows or set TEST_SH to its sh.exe')
const shellTools = process.platform === 'win32' ? path.resolve(path.dirname(shell), '../usr/bin') + path.delimiter : ''
const env = { ...process.env, PATH: shellTools + process.env.PATH }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function service() {
    return new StatsService({ changed$: new Subject(), ready$: new Subject(), store: { plugin: { serverStats: {} } } })
}

/** Model the shared SSH connection's packet ceiling, but execute the real transmitted
 * command and streamed bytes in a real POSIX shell. A second real shell represents
 * the interactive channel: an oversized request disconnects BOTH channels. */
function transport({ packetLimit = 32768, writeDelay = 0, finalWriteDelay = 0, failWriteAt = 0, withoutWrite = false } = {}) {
    const data = new Subject(), closed = new Subject(), stderr = new Subject()
    const keeper = spawn(shell, ['-s'], { env })
    keeper.stdin.on('error', () => {})
    let remote, connectionOpen = true, monitorClosed = false, disposed = false, keeperClosed = false
    let closeCalls = 0, disconnects = 0, uploads = 0, inFlightWrites = 0, ackWrites = 0, ackBeforeUploadSettled = false, writesAfterClose = 0
    let keeperSequence = 0, finalDataBeforeUploadSettled = false, monitorOutput = ''
    const execRequests = [], chunks = [], active = new Set([keeper])
    const keeperWaiters = new Map()
    let keeperText = ''
    keeper.stdout.on('data', bytes => {
        keeperText += bytes.toString('utf8')
        for (const [marker, waiter] of keeperWaiters) if (keeperText.includes(marker)) { keeperWaiters.delete(marker); waiter.resolve(marker) }
    })
    keeper.on('close', () => {
        keeperClosed = true
        for (const waiter of keeperWaiters.values()) waiter.reject(new Error('Interactive channel closed'))
        keeperWaiters.clear()
    })
    function disconnect() {
        disconnects++
        connectionOpen = false
        for (const child of active) child.kill()
        closed.next()
    }
    const channel = {
        data$: data, closed$: closed, extendedData$: stderr,
        requestExec: async command => {
            const bytes = Buffer.byteLength(command)
            execRequests.push(bytes)
            // CHANNEL_REQUEST framing/padding needs space beyond the command string.
            if (bytes + 64 > packetLimit) { disconnect(); throw new Error('Packet corrupt: oversized SSH exec request') }
            remote = spawn(shell, ['-c', command], { env })
            active.add(remote)
            remote.stdin.on('error', () => {})
            remote.stdout.on('data', bytes => {
                monitorOutput += bytes.toString('utf8')
                if (bytes.includes(Buffer.from('TABBY-STATS-END')) && inFlightWrites) finalDataBeforeUploadSettled = true
                data.next(bytes)
            })
            remote.stderr.on('data', bytes => stderr.next([1, bytes]))
            remote.on('error', error => data.error(error))
            remote.on('close', () => { closed.next(); data.complete() })
        },
        write: async bytes => {
            if (monitorClosed) writesAfterClose++
            if (!connectionOpen || monitorClosed || !remote) throw new Error('Channel not writable')
            const chunk = Buffer.from(bytes)
            if (chunk.length + 64 > packetLimit) { disconnect(); throw new Error('Packet corrupt: oversized SSH channel data') }
            const ack = chunk.equals(Buffer.from('TABBY-STATS-ACK\n'))
            if (ack) {
                ackWrites++
                if (inFlightWrites) ackBeforeUploadSettled = true
            } else {
                uploads++
                chunks.push(chunk)
                if (failWriteAt === uploads) throw new Error('Injected upload failure')
            }
            inFlightWrites++
            try {
                await new Promise((resolve, reject) => remote.stdin.write(chunk, error => error ? reject(error) : resolve()))
                // Native SSH write completion may lag behind remote output. This
                // deliberately exposes ACK/upload races after the last source chunk.
                const delay = Math.max(writeDelay, chunk.subarray(-2).equals(Buffer.from('}\n')) ? finalWriteDelay : 0)
                if (!ack && delay) await pause(delay)
            } finally { inFlightWrites-- }
        },
        close: async () => {
            closeCalls++
            monitorClosed = true
            if (remote) { remote.stdin.end(); remote.kill() }
        }
    }
    if (withoutWrite) delete channel.write
    return {
        client: { openSessionChannel: async () => channel, activateChannel: async channel => channel },
        data, closed, stderr,
        counts: () => ({ execRequests, uploads, chunks, closeCalls, disconnects, ackWrites, ackBeforeUploadSettled, writesAfterClose, finalDataBeforeUploadSettled, monitorOutput, connectionOpen, keeperClosed }),
        ping: async () => {
            assert(connectionOpen && !keeperClosed, 'The neighboring interactive channel must remain open')
            const marker = `KEEPER_OK_${++keeperSequence}`
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { keeperWaiters.delete(marker); reject(new Error('Interactive channel did not respond')) }, 2000)
                keeperWaiters.set(marker, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
                keeper.stdin.write(`printf '${marker}\\n'\n`)
            })
        },
        dispose: async () => {
            if (disposed) return
            disposed = true
            for (const child of active) { child.stdin.destroy(); child.kill() }
            await Promise.all([...active].map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve))))
        }
    }
}

function paddedScript(targetBytes, value = '可用 4G / quote: \"\x27 / } ; $(not executed) 😀') {
    const line = '# 中😀 UTF-8 quote "\x27 $() } ' + 'x'.repeat(64) + '\n'
    const padding = line.repeat(Math.ceil(targetBytes / Buffer.byteLength(line)))
    return `printf 'SOURCE_STARTED\\n'\n${padding}printf '%s\\n' ${shellQuote(`TABBY-METRIC-RESULT:detail:ok:${value}`)}\necho TABBY-STATS-END\n`
}

test('production SSH transport streams 100 KB of UTF-8 through bounded packets and preserves a neighboring terminal', async () => {
    const fixture = transport({ packetLimit: 32768, writeDelay: 8, finalWriteDelay: 500 })
    const instance = service()
    const value = '可用 4G / quote: \"\x27 / } ; $(not executed) 😀'
    const script = paddedScript(100000, value)
    try {
        assert.match(await fixture.ping(), /KEEPER_OK/)
        const output = await instance.exec(fixture.client, script, 6000)
        assert.deepEqual(parseMetricResults(output), [{ token: 'detail', status: 'ok', value }])
        const counts = fixture.counts()
        assert.equal(counts.execRequests.length, 1)
        assert(counts.execRequests[0] < 1024, 'The exec request contains only a small launcher, never the user script')
        assert(counts.chunks.length > 1)
        assert(counts.chunks.every(chunk => chunk.length <= 8192), 'All streamed source packets stay below the portable SSH minimum limit')
        assert(Buffer.concat(counts.chunks).includes(Buffer.from(script)), 'The original UTF-8 shell source is preserved byte-for-byte')
        assert.equal(counts.ackWrites, 1)
        assert.equal(counts.ackBeforeUploadSettled, false)
        assert.equal(counts.finalDataBeforeUploadSettled, true, 'Fixture exercises remote END arriving before the final write promise resolves')
        assert.equal(counts.disconnects, 0)
        assert.equal(counts.closeCalls, 1)
        assert.match(await fixture.ping(), /KEEPER_OK/)
        // Duplicate or late events must not re-close the channel, leak handlers,
        // or disconnect the shared SSH connection after successful delivery.
        fixture.closed.next(); fixture.data.next(Buffer.from('late packet'))
        await pause(120)
        assert.equal(fixture.counts().closeCalls, 1)
        assert.equal(fixture.data.observers.length, 0)
        assert.equal(fixture.closed.observers.length, 0)
        assert.equal(fixture.stderr.observers.length, 0)
        assert.match(await fixture.ping(), /KEEPER_OK/)
    } finally { await fixture.dispose() }
})

test('a timeout during source upload stops later writes and leaves the interactive channel usable', async () => {
    const fixture = transport({ writeDelay: 250 })
    try {
        await fixture.ping()
        await assert.rejects(service().exec(fixture.client, paddedScript(70000), 80), /Timeout/)
        const writesAtTimeout = fixture.counts().uploads
        assert.equal(writesAtTimeout, 1, 'Timeout happens while the first source write is pending')
        await pause(300)
        assert.equal(fixture.counts().uploads, writesAtTimeout)
        assert.equal(fixture.counts().writesAfterClose, 0)
        assert.equal(fixture.counts().closeCalls, 1)
        assert.equal(fixture.counts().disconnects, 0)
        assert.equal(fixture.counts().ackWrites, 0)
        assert.equal(fixture.counts().monitorOutput, '', 'No command executes before the complete compound source has arrived')
        assert.match(await fixture.ping(), /KEEPER_OK/)
    } finally { await fixture.dispose() }
})

test('a source upload error cleans up only the statistics channel and never retries a partial command', async () => {
    const fixture = transport({ failWriteAt: 2 })
    try {
        await fixture.ping()
        await assert.rejects(service().exec(fixture.client, paddedScript(70000), 2000), /Injected upload failure/)
        assert.equal(fixture.counts().execRequests.length, 1)
        assert.equal(fixture.counts().uploads, 2)
        assert.equal(fixture.counts().closeCalls, 1)
        assert.equal(fixture.counts().disconnects, 0)
        assert.equal(fixture.counts().ackWrites, 0)
        assert.equal(fixture.counts().monitorOutput, '', 'A partial source upload cannot execute its first command')
        assert.match(await fixture.ping(), /KEEPER_OK/)
    } finally { await fixture.dispose() }
})

test('a channel without streaming support fails safely before sending any oversized exec request', async () => {
    const fixture = transport({ withoutWrite: true })
    try {
        await fixture.ping()
        await assert.rejects(service().exec(fixture.client, paddedScript(70000), 2000), /write|stdin|input|upload|transport|stream/i)
        assert(fixture.counts().execRequests.every(size => size < 1024))
        assert.equal(fixture.counts().disconnects, 0)
        assert.equal(fixture.counts().closeCalls, 1)
        assert.match(await fixture.ping(), /KEEPER_OK/)
    } finally { await fixture.dispose() }
})
