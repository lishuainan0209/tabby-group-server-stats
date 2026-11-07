const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync, spawn } = require('node:child_process');
const ts = require('typescript');
const { Subject, ReplaySubject } = require('rxjs');

require.extensions['.ts'] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017, experimentalDecorators: true
    }}).outputText;
    module._compile(output, filename);
};
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
    if (name === '@angular/core') return { Injectable: () => type => type };
    if (name === 'tabby-core') return {};
    if (name === './metric-scope.service') return { MetricScopeService: class {} };
    return originalLoad.call(this, name, parent, isMain);
};
const { buildMetricCommand, parseMetricResults, allMetrics } = require('../src/metric-model.ts');
const { StatsService } = require('../src/services/stats.service.ts');
const gitExecPath = process.platform === 'win32' ? spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() : '';
const gitShell = gitExecPath ? path.resolve(gitExecPath, '../../..', 'bin/sh.exe') : '';
const shell = process.env.TEST_SH || (process.platform === 'win32' ?
    [gitShell, 'C:\\Program Files\\Git\\bin\\sh.exe', 'S:\\Git\\bin\\sh.exe'].find(file => file && fs.existsSync(file)) : '/bin/sh');
if (!shell) throw new Error('Install Git for Windows or set TEST_SH to its sh.exe');
const shellTools = process.platform === 'win32' ? path.resolve(path.dirname(shell), '../usr/bin') + path.delimiter : '';
function run(metric, kind = 'value') {
    const result = spawnSync(shell, ['-s'], {
        input: buildMetricCommand(metric, 'test', kind) + '\nwait\n', encoding: 'utf8', timeout: 7000,
        env: { ...process.env, PATH: shellTools + process.env.PATH }
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return { ...result, parsed: parseMetricResults(result.stdout)[0] };
}
const metric = extra => ({ id: 'disk', type: 'text', command: 'printf 42', ...extra });
function service(metrics = [metric()], groups = [], options = {}) {
    const config = { changed$: new Subject(), ready$: new Subject(), store: { profiles: options.profiles || [], plugin: { serverStats: {
        customMetrics: metrics, metricGroups: groups, defaultMetrics: { cpu: false, ram: false, disk: false, net: false }
    }}} };
    const instance = new StatsService(config, options.scopes);
    instance.isPlatformSupport = session => Boolean(session && session.open !== false);
    return { instance, config, session: { open: true } };
}
function packet(status, value = '', token = 'm_0') {
    return `TABBY-METRIC-RESULT:${token}:${status}:${value}\nTABBY-STATS-END\n`;
}
function due(instance, session, id = 'disk') {
    instance.getSessionCache(session).metricStates.get(id).lastAttempt = 0;
}

test('unconfigured check preserves the last nonempty output and explicit status', () => {
    assert.deepEqual(run(metric({ command: "printf 'ignored\\nErr: valid text\\n\\n'" })).parsed,
        { token: 'test', status: 'ok', value: 'Err: valid text' });
});
test('output checks trim whitespace, ignore stderr, and match case sensitively', () => {
    const passed = run(metric({ checkCommand: "printf '  exists\\n'; printf noise >&2", checkMode: 'output', checkExpected: 'exists' }));
    assert.equal(passed.parsed.value, '42');
    assert.match(passed.stderr, /noise/);
    assert.equal(run(metric({ checkCommand: 'printf EXISTS', checkMode: 'output', checkExpected: 'exists' })).parsed.status, 'unavailable');
});
test('exit code check supports default zero and a specified nonzero value', () => {
    assert.equal(run(metric({ checkCommand: 'exit 0' })).parsed.status, 'ok');
    assert.equal(run(metric({ checkCommand: 'exit 7', checkExpected: '7' })).parsed.status, 'ok');
});
test('failed check never executes either value or detail command', () => {
    const input = metric({ checkCommand: 'exit 1', command: 'printf BAD >&2', detailCommand: 'printf BAD >&2' });
    for (const kind of ['value', 'detail']) {
        const result = run(input, kind);
        assert.equal(result.parsed.status, 'unavailable');
        assert.doesNotMatch(result.stderr, /BAD/);
    }
});
test('quoted expected strings are data and cannot execute substitutions', () => {
    const text = "a'$(printf BAD >&2)";
    const result = run(metric({ checkCommand: 'printf "a\x27\\$(printf BAD >&2)"', checkMode: 'output', checkExpected: text }));
    assert.equal(result.parsed.status, 'ok');
    assert.doesNotMatch(result.stderr, /BAD/);
});
test('check timeout is an error and cannot run the value command', () => {
    const result = run(metric({ timeout: 1, checkCommand: 'sleep 3', command: 'printf BAD >&2' }));
    assert.equal(result.parsed.status, 'error');
    assert.match(result.parsed.value, /Check timeout/);
    assert.doesNotMatch(result.stderr, /BAD/);
});
test('functional errors and timeouts do not become successful numeric values', () => {
    assert.equal(run(metric({ command: 'exit 4' })).parsed.status, 'error');
    assert.match(run(metric({ timeout: 1, command: 'sleep 3' })).parsed.value, /Timeout/);
});
test('detail output includes all lines without changing the primary format', () => {
    assert.equal(run(metric({ detailCommand: "printf 'free 4G\\nused 6G'" }), 'detail').parsed.value, 'free 4G used 6G');
});

test('successful empty detail output remains empty, not a missing result or numeric zero', () => {
    assert.deepEqual(run(metric({ detailCommand: 'true' }), 'detail').parsed,
        { token: 'test', status: 'ok', value: '' });
});
test('parser ignores incomplete SSH frames and keeps colons/unicode in values', () => {
    assert.deepEqual(parseMetricResults('TABBY-METRIC-RESULT:test:ok:容量: 4G'), []);
    assert.equal(parseMetricResults('TABBY-METRIC-RESULT:test:ok:容量: 4G\n')[0].value, '容量: 4G');
});
test('legacy metrics and all group members are collected exactly once', () => {
    const main = metric({ id: 'main' }), child = metric({ id: 'child' });
    assert.deepEqual(allMetrics({ customMetrics: [metric()], metricGroups: [{ main, children: [child, child] }] }).map(x => x.id), ['disk', 'main', 'child']);
});
test('disabled metrics, whole groups and individual members never execute values or details', async () => {
    const off = id => metric({ id, enabled: false, command: `printf disabled-${id}`, detailCommand: `printf disabled-detail-${id}` });
    const child = metric({ id: 'active-child', command: 'printf child', detailCommand: 'printf child-detail' });
    const disabledGroup = { id: 'off-group', enabled: false, main: metric({ id: 'off-main', command: 'printf disabled-group' }), children: [metric({ id: 'off-child' })] };
    const group = { id: 'on-group', main: off('main'), children: [off('child'), child] };
    const definitions = [off('single')];
    const { instance, session } = service(definitions, [disabledGroup, group]);
    const original = JSON.stringify([definitions, disabledGroup, group]);
    let calls = 0;
    instance.execute = async (_session, script) => {
        calls++;
        assert.doesNotMatch(script, /disabled|m_1/);
        return script.includes('RESULT:detail:') ? packet('ok', 'child-detail', 'detail') : packet('ok', 'child');
    };
    assert.deepEqual((await instance.fetchStats(session)).custom.map(m => m.id), ['active-child']);
    const requested = [...definitions, disabledGroup.main, ...disabledGroup.children, group.main, ...group.children];
    assert.deepEqual(await instance.fetchDetails(session, requested), { 'active-child': 'child-detail' });
    assert.equal(calls, 2);
    assert.equal(JSON.stringify([definitions, disabledGroup, group]), original);
    child.enabled = false;
    assert.deepEqual((await instance.fetchStats(session)).custom, []);
    assert.deepEqual(await instance.fetchDetails(session, requested), {});
    assert.equal(calls, 2);
});
test('hiding unavailable values does not stop checks from detecting recovery', async () => {
    const input = metric({ visibleWhenUnavailable: false, checkCommand: 'exit 0' });
    const { instance, session } = service([input]);
    let output = packet('unavailable');
    instance.execute = async () => output;
    assert.equal((await instance.fetchStats(session)).custom[0].status, 'unavailable');
    due(instance, session); output = packet('ok', '63');
    assert.equal((await instance.fetchStats(session)).custom[0].value, '63');
});
test('editable builtin commands, checks, details, scopes and enabled flags share the generic collector', async () => {
    const { instance, config, session } = service([], [], { profiles: [{ id: 'p1' }] });
    session.profile = { id: 'p1' };
    const conf = config.store.plugin.serverStats;
    conf.defaultMetrics = { ram: true };
    conf.defaultMetricOverrides = { ram: {
        command: 'printf 37', checkCommand: 'printf ready', checkMode: 'output', checkExpected: 'ready',
        type: 'text', detailCommand: 'printf edited-details', displayScope: { mode: 'selected', profileIds: ['p1'] }
    }};
    let calls = 0;
    instance.execute = async (_session, script) => {
        calls++;
        assert.doesNotMatch(script, /TABBY-STATS-START|\/proc\/meminfo/);
        const result = spawnSync(shell, ['-s'], { input: script, encoding: 'utf8', timeout: 7000,
            env: { ...process.env, PATH: shellTools + process.env.PATH } });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    const data = await instance.fetchStats(session);
    assert.deepEqual(data.custom, [{ id: 'builtin-ram', status: 'ok', value: '37' }]);
    assert.equal(data.mem, 37);
    const visible = instance.getVisibleConfig(session).customMetrics;
    assert.equal(visible[0].type, 'text');
    assert.deepEqual(await instance.fetchDetails(session, visible), { 'builtin-ram': 'edited-details' });
    session.profile.id = 'other';
    assert.deepEqual((await instance.fetchStats(session)).custom, []);
    session.profile.id = 'p1';
    conf.defaultMetricOverrides.ram.enabled = false;
    assert.deepEqual((await instance.fetchStats(session)).custom, []);
    assert.deepEqual(await instance.fetchDetails(session, visible), {});
    assert.equal(calls, 2);
});
test('failure replaces a previously valid value and recovery retries normally', async () => {
    const { instance, session } = service([metric({ unavailableText: '未挂载' })]);
    let output = packet('ok', '60');
    instance.execute = async () => output;
    assert.equal((await instance.fetchStats(session)).custom[0].value, '60');
    due(instance, session); output = packet('unavailable');
    assert.deepEqual((await instance.fetchStats(session)).custom[0], { id: 'disk', value: '未挂载', status: 'unavailable' });
    due(instance, session); output = packet('ok', '61');
    assert.equal((await instance.fetchStats(session)).custom[0].status, 'ok');
});
test('main-group failure does not suppress children', async () => {
    const { instance, session } = service([], [{ main: metric({ id: 'main' }), children: [metric({ id: 'child' })] }]);
    instance.execute = async (_session, script) => {
        assert.match(script, /m_0/); assert.match(script, /m_1/);
        return packet('unavailable', '', 'm_0') + packet('ok', '52', 'm_1');
    };
    assert.deepEqual((await instance.fetchStats(session)).custom.map(x => x.status), ['unavailable', 'ok']);
});
test('hover recheck failure clears displayed value and never retains detail cache', async () => {
    const input = metric({ checkCommand: 'exit 0', detailCommand: 'printf details', unavailableText: 'missing' });
    const { instance, session } = service([input]);
    instance.execute = async () => packet('ok', '50');
    await instance.fetchStats(session);
    instance.execute = async (_session, script) => {
        assert.match(script, /exit 0/);
        return packet('unavailable', '', 'detail');
    };
    assert.deepEqual(await instance.fetchDetails(session, [input]), { disk: '' });
    assert.deepEqual(instance.getCachedStats(session).custom[0], { id: 'disk', value: 'missing', status: 'unavailable' });
});
test('missing detail command and known failed checks do not execute detail requests', async () => {
    const input = metric({ detailCommand: 'printf details' });
    const { instance, session } = service([input, metric({ id: 'empty' })]);
    let calls = 0;
    instance.execute = async () => { calls++; return packet('unavailable'); };
    await instance.fetchStats(session);
    const before = calls;
    assert.deepEqual(await instance.fetchDetails(session, [input, metric({ id: 'empty' })]), { disk: '' });
    assert.equal(calls, before);
});
test('simultaneous hover requests are deduplicated and recent details cached', async () => {
    const input = metric({ detailCommand: 'printf details' });
    const { instance, session } = service([input]);
    let calls = 0, release;
    instance.execute = () => { calls++; return new Promise(resolve => { release = resolve; }); };
    const first = instance.fetchDetails(session, [input]);
    const second = instance.fetchDetails(session, [input]);
    release(packet('ok', 'free 5G', 'detail'));
    assert.deepEqual(await first, { disk: 'free 5G' });
    assert.deepEqual(await second, { disk: 'free 5G' });
    await instance.fetchDetails(session, [input]);
    assert.equal(calls, 1);
});

test('hover refresh respects metric interval, configured default, fallback three seconds and minimum one second', async () => {
    for (const [metricInterval, defaultInterval, expected] of [[10, 3, 10], [undefined, 7, 7], [undefined, undefined, 3], [0.1, 3, 1]]) {
        const input = metric({ interval: metricInterval, detailCommand: 'printf details' });
        const { instance, session, config } = service([input]);
        config.store.plugin.serverStats.defaultInterval = defaultInterval;
        let calls = 0;
        instance.execute = async () => { calls++; return packet('ok', String(calls), 'detail'); };
        await instance.fetchDetails(session, [input]);
        const state = instance.getSessionCache(session).metricStates.get(input.id);
        if (expected > 2) {
            state.detailAt = Date.now() - 2100;
            assert.deepEqual(await instance.fetchDetails(session, [input]), { disk: '1' });
            assert.equal(calls, 1, 'A two-second UI poll must not bypass the metric refresh interval');
        }
        state.detailAt = Date.now() - expected * 1000 + 250;
        await instance.fetchDetails(session, [input]);
        assert.equal(calls, 1);
        state.detailAt = Date.now() - expected * 1000 - 1;
        assert.deepEqual(await instance.fetchDetails(session, [input]), { disk: '2' });
        assert.equal(calls, 2);
    }
});
test('config changes and closed sessions discard late results and emissions', async () => {
    for (const reason of ['config', 'close']) {
        const { instance, session, config } = service();
        let release, emitted = 0;
        instance.statsUpdated$.subscribe(() => emitted++);
        instance.execute = () => new Promise(resolve => { release = resolve; });
        const task = instance.fetchStats(session);
        if (reason === 'config') config.changed$.next(); else session.open = false;
        release(packet('ok', '99'));
        assert.equal(await task, null);
        assert.equal(emitted, 0);
    }
});
test('same saved profile uses independent session caches', () => {
    const { instance } = service();
    assert.notEqual(instance.getServerKey({ profile: { id: 'same' } }), instance.getServerKey({ profile: { id: 'same' } }));
});
test('regular collection and hover do not overlap work for the same metric', async () => {
    const input = metric({ detailCommand: 'printf details' });
    const { instance, session } = service([input]);
    let release, calls = 0;
    instance.execute = async (_session, script) => {
        calls++;
        if (script.includes('RESULT:detail:')) return packet('ok', 'detail', 'detail');
        return new Promise(resolve => { release = resolve; });
    };
    const collecting = instance.fetchStats(session);
    const duplicate = instance.fetchStats(session);
    const detail = instance.fetchDetails(session, [input]);
    assert.equal(calls, 1);
    release(packet('ok', '42'));
    await Promise.all([collecting, duplicate]);
    assert.deepEqual(await detail, { disk: 'detail' });
    assert.equal(calls, 2);
});
test('late hover result cannot repopulate cache after a configuration change', async () => {
    const input = metric({ detailCommand: 'printf old' });
    const { instance, session, config } = service([input]);
    let release;
    instance.execute = () => new Promise(resolve => { release = resolve; });
    const task = instance.fetchDetails(session, [input]);
    config.changed$.next();
    release(packet('ok', 'old', 'detail'));
    assert.deepEqual(await task, {});
    assert.equal(instance.getCachedStats(session), null);
});
test('hover on a streamed metric does not wait for an unrelated slow sibling', async () => {
    const fast = metric({ detailCommand: 'printf details' });
    const slow = metric({ id: 'slow', command: 'sleep 30; printf 1' });
    const { instance, session } = service([fast, slow]);
    let finishSlow, detailCalls = 0;
    instance.execute = async (_session, script, _timeout, onChunk) => {
        if (script.includes('RESULT:detail:')) {
            detailCalls++;
            return packet('ok', 'free 4G', 'detail');
        }
        onChunk('TABBY-METRIC-RESULT:m_0:ok:60\n');
        return new Promise(resolve => { finishSlow = resolve; });
    };
    const collection = instance.fetchStats(session);
    let collectionDone = false;
    collection.then(() => { collectionDone = true; });
    try {
        const detail = await Promise.race([
            instance.fetchDetails(session, [fast]),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Hover waited for unrelated metric')), 200))
        ]);
        assert.deepEqual(detail, { disk: 'free 4G' });
        assert.equal(detailCalls, 1);
        assert.equal(collectionDone, false);
    } finally {
        finishSlow(packet('ok', '1', 'm_1'));
        await collection;
    }
});
test('SSH timeout closes its channel and releases subscriptions', async () => {
    const { instance } = service();
    const data = new Subject(); let closed = 0;
    const channel = { data$: data, close: () => closed++, requestExec: async () => {}, write: async () => {} };
    const client = { openSessionChannel: async () => channel, activateChannel: async x => x };
    await assert.rejects(instance.exec(client, 'true', 20), /Timeout/);
    assert.equal(closed, 1);
    assert.equal(data.observers.length, 0);
});

function sshFixture(onExec, data = new Subject()) {
    const closed = new Subject(), stderr = new Subject();
    let closeCalls = 0, execCalls = 0;
    let command = '', started = false;
    const uploaded = [];
    const channel = {
        data$: data, closed$: closed, extendedData$: stderr,
        close: async () => { closeCalls++; },
        requestExec: async value => { execCalls++; command = value; assert.equal(command, '/bin/sh -s'); },
        write: async bytes => {
            if (started) { assert.equal(Buffer.from(bytes).toString(), 'TABBY-STATS-ACK\n'); return; }
            uploaded.push(Buffer.from(bytes));
            const script = Buffer.concat(uploaded).toString('utf8');
            if (script.endsWith('\nexit\n}\n')) {
                started = true;
                await onExec({ command, script, data, closed, stderr });
            }
        },
        eof: async () => {},
    };
    const client = { openSessionChannel: async () => channel, activateChannel: async channel => channel };
    return { client, channel, data, closed, stderr, counts: () => ({ closeCalls, execCalls }) };
}

test('END acknowledgment prevents output loss through russh destructive close buffers without rerunning commands', async () => {
    // Models russh 0.1.38 lib/events.js: observable captures the current buffer,
    // Close deletes it, and late Data is routed into a new buffer without subscribers.
    function destructiveFixture() {
        const buffers = new Map([[7, new Subject()]]), closed = new Subject();
        const data = buffers.get(7);
        let execCalls = 0, acknowledgments = 0, emitted = false, script = '';
        const remoteClose = () => { closed.next(); buffers.delete(7); };
        const remoteData = value => {
            if (!buffers.has(7)) buffers.set(7, new Subject());
            emitted = true;
            buffers.get(7).next(Buffer.from(value));
        };
        const channel = {
            data$: data, closed$: closed, close: async () => {},
            requestExec: async command => {
                execCalls++;
                assert.equal(command, '/bin/sh -s');
            },
            write: async bytes => {
                const text = Buffer.from(bytes).toString();
                if (emitted) {
                    assert.equal(text, 'TABBY-STATS-ACK\n');
                    acknowledgments++;
                    remoteClose();
                    return;
                }
                script += text;
                if (!script.endsWith('\nexit\n}\n')) return;
                // Separate native callbacks may deliver remote Close before stdout.
                // The bounded server wait removes Close until the client acknowledges.
                if (!script.includes('# TABBY-STATS-ACK-WAIT')) remoteClose();
                setTimeout(() => remoteData(packet('ok', 'received once', 'detail')), 20);
            },
            eof: async () => {},
        };
        return { client: { openSessionChannel: async () => channel, activateChannel: async c => c },
            counts: () => ({ execCalls, acknowledgments }), data, closed };
    }
    const { instance } = service();
    const unguarded = destructiveFixture();
    await assert.rejects(instance.exec(unguarded.client, 'echo TABBY-METRIC-RESULT:detail:ok:x', 1000), /No output/);
    const guarded = destructiveFixture();
    assert.equal(await instance.exec(guarded.client, 'echo TABBY-METRIC-RESULT:detail:ok:x\necho TABBY-STATS-END\n', 1000), packet('ok', 'received once', 'detail'));
    assert.deepEqual(guarded.counts(), { execCalls: 1, acknowledgments: 1 });
    assert.equal(guarded.data.observers.length, 0);
    assert.equal(guarded.closed.observers.length, 0);
});

test('completion wait accepts ACK or EOF promptly and remains bounded without a client reply', async () => {
    const { instance } = service();
    async function capture(forceWatchdog) {
        let captured;
        const fixture = sshFixture(({ script, data }) => { captured = script; data.next(Buffer.from(packet('ok', 'once', 'detail'))); });
        const setup = forceWatchdog === 'unsupported' ? 'timeout() { return 2; }\ngtimeout() { return 2; }\n' :
            forceWatchdog ? 'command() { return 1; }\n' : '';
        await instance.exec(fixture.client, `${setup}printf 'TABBY-METRIC-RESULT:detail:ok:once\\n'\necho TABBY-STATS-END\n`, 1000);
        return captured;
    }
    async function runCaptured(script, reply) {
        const start = Date.now();
        return await new Promise((resolve, reject) => {
            const child = spawn(shell, ['-s'], { env: { ...process.env, PATH: shellTools + process.env.PATH } });
            let stdout = '', stderr = '', replied = false;
            const deadline = setTimeout(() => { child.kill(); reject(new Error('Remote ACK wait exceeded its bound')); }, 8000);
            child.stdout.on('data', data => {
                stdout += data.toString();
                if (!replied && stdout.includes('TABBY-STATS-END\n')) {
                    replied = true;
                    if (reply === 'ack') child.stdin.write('TABBY-STATS-ACK\n');
                    if (reply === 'eof') child.stdin.end();
                }
            });
            child.stderr.on('data', data => { stderr += data.toString(); });
            child.on('error', error => { clearTimeout(deadline); reject(error); });
            child.on('close', code => { clearTimeout(deadline); child.stdin.destroy(); resolve({ code, stdout, stderr, duration: Date.now() - start }); });
            child.stdin.write(script);
        });
    }
    for (const forceWatchdog of [false, true, 'unsupported']) {
        const command = await capture(forceWatchdog);
        for (const reply of forceWatchdog === 'unsupported' ? ['none'] : ['ack', 'eof', 'none']) {
            const result = await runCaptured(command, reply);
            assert.equal(result.code, 0, result.stderr);
            assert.equal(parseMetricResults(result.stdout).length, 1, 'The user command executes exactly once');
            if (reply === 'none') assert(result.duration >= 4500 && result.duration < 7500, `Bounded wait: ${result.duration}ms`);
            else assert(result.duration < 2500, `ACK/EOF should release promptly: ${result.duration}ms`);
        }
    }
});

test('unsupported stdin upload fails before exec; a stalled ACK releases complete results and cleans subscriptions', async () => {
    const { instance } = service();
    const unsupported = sshFixture(() => assert.fail('unsupported upload must not execute'));
    delete unsupported.channel.write;
    await assert.rejects(instance.exec(unsupported.client, 'true', 1000), /does not support stdin upload/);
    assert.deepEqual(unsupported.counts(), { closeCalls: 1, execCalls: 0 });
    assert.equal(unsupported.data.observers.length, 0);
    let released = 0, closes = 0;
    const data = new Subject();
    const channel = { data$: data, close: async () => { closes++; }, requestExec: async () => {},
        write: bytes => {
            if (Buffer.from(bytes).toString() === 'TABBY-STATS-ACK\n') { released++; return new Promise(() => {}); }
            data.next(Buffer.from(packet('ok', '42', 'detail')));
            return Promise.resolve();
        } };
    const client = { openSessionChannel: async () => channel, activateChannel: async c => c };
    // END can arrive before the final upload Promise resolves. Neither that
    // Promise nor a stalled ACK may turn complete results into a timeout.
    assert.equal(await instance.exec(client, 'echo TABBY-STATS-END\n', 30), packet('ok', '42', 'detail'));
    assert.equal(released, 1);
    assert.equal(closes, 1);
    assert.equal(data.observers.length, 0);
});

test('SSH drains final data after a close event using idle time rather than cutting an active stream', async () => {
    const { instance } = service();
    const output = packet('ok', '可用 4GB', 'detail');
    const bytes = Buffer.from(output);
    const split = Buffer.from('TABBY-METRIC-RESULT:detail:ok:').length + 1;
    const fixture = sshFixture(({ data, closed }) => {
        closed.next();
        setTimeout(() => data.next(bytes.subarray(0, split)), 60);
        // The old fixed 100 ms close timer truncated this UTF-8 protocol frame.
        setTimeout(() => data.next(bytes.subarray(split)), 130);
    });
    assert.equal(await instance.exec(fixture.client, 'echo TABBY-METRIC-RESULT:detail:ok:x', 1000), output);
    assert.equal(fixture.data.observers.length, 0);
    assert.equal(fixture.closed.observers.length, 0);
    assert.equal(fixture.stderr.observers.length, 0);
});

test('SSH stdin transport preserves quotes, substitutions and multiline UTF-8 details', async () => {
    const { instance } = service();
    const input = metric({ detailCommand: 'printf "可用 4G\\nused: $(printf 6)G"' });
    const script = buildMetricCommand(input, 'detail', 'detail') + '\nwait\necho TABBY-STATS-END\n';
    const fixture = sshFixture(({ command, script, data }) => {
        assert.equal(command, '/bin/sh -s');
        const result = spawnSync(shell, ['-s'], {
            input: script, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: shellTools + process.env.PATH }
        });
        assert.equal(result.status, 0, result.stderr);
        data.next(Buffer.from(result.stdout));
    });
    const result = parseMetricResults(await instance.exec(fixture.client, script, 6000));
    assert.deepEqual(result, [{ token: 'detail', status: 'ok', value: '可用 4G used: 6G' }]);
});

test('SSH diagnostics distinguish empty stdout, truncated frames and remote shell errors', async () => {
    const { instance } = service();
    for (const [stdout, stderrText, expected] of [
        ['', '', /Stats: No output/],
        ['TABBY-METRIC-RESULT:detail:ok:partial', '', /Stats: Incomplete output/],
        ['', 'sh: unexpected end of file\n', /Stats: Remote error: sh: unexpected end of file/],
    ]) {
        const fixture = sshFixture(({ data, stderr, closed }) => {
            if (stdout) data.next(Buffer.from(stdout));
            if (stderrText) stderr.next([1, Buffer.from(stderrText)]);
            closed.next();
        });
        await assert.rejects(instance.exec(fixture.client, 'echo TABBY-METRIC-RESULT:detail:ok:x', 1000), expected);
        assert.equal(fixture.stderr.observers.length, 0);
    }
});

test('detail transport failures keep the successful primary value and cache an explicit diagnostic', async () => {
    const input = metric({ detailCommand: 'printf details' });
    const { instance, session } = service([input]);
    instance.execute = async () => packet('ok', '42');
    await instance.fetchStats(session);
    instance.execute = async () => { throw new Error('Stats: Remote error: sh: test failure'); };
    assert.deepEqual(await instance.fetchDetails(session, [input]), { disk: 'Err: Remote error: sh: test failure' });
    assert.deepEqual(instance.getCachedStats(session).custom[0], { id: 'disk', value: '42', status: 'ok' });
});

test('synchronous buffered SSH completion does not leak subscriptions or execute on a closed channel', async () => {
    const { instance } = service();
    const data = new ReplaySubject(1);
    data.next(Buffer.from(packet('ok', '42')));
    const fixture = sshFixture(() => assert.fail('must not execute after completion'), data);
    assert.equal(await instance.exec(fixture.client, 'echo TABBY-METRIC-RESULT:m_0:ok:x', 1000), packet('ok', '42'));
    assert.equal(data.observers.length, 0);
    assert.deepEqual(fixture.counts(), { closeCalls: 1, execCalls: 0 });
});

const selected = (...profileIds) => ({ mode: 'selected', profileIds });
const saved = (...ids) => ids.map(id => ({ id, name: id, type: id.startsWith('layout') ? 'split-layout' : 'ssh' }));
function echoPackets(script) {
    const tokens = [...new Set([...script.matchAll(/TABBY-METRIC-RESULT:(m_\d+):/g)].map(match => match[1]))];
    return tokens.map(token => packet('ok', token, token)).join('');
}

test('scope: mixed-layout P1, P2, P1 sessions collect only each leaf profile plus global metrics', async () => {
    const global = metric({ id: 'global', command: 'printf GLOBAL' });
    const p1 = metric({ id: 'p1', command: 'printf ONLY_P1', displayScope: selected('P1') });
    const p2 = metric({ id: 'p2', command: 'printf ONLY_P2', displayScope: selected('P2') });
    const { instance } = service([global, p1, p2], [], { profiles: saved('P1', 'P2') });
    const sessions = ['P1', 'P2', 'P1'].map(id => ({ open: true, profile: { id } }));
    instance.execute = async (session, script) => {
        assert.match(script, /printf GLOBAL/);
        assert.match(script, session.profile.id === 'P1' ? /printf ONLY_P1/ : /printf ONLY_P2/);
        assert.doesNotMatch(script, session.profile.id === 'P1' ? /printf ONLY_P2/ : /printf ONLY_P1/);
        return echoPackets(script);
    };
    for (const session of sessions) {
        const data = await instance.fetchStats(session);
        assert.deepEqual(data.custom.map(m => m.id), ['global', session.profile.id.toLowerCase()]);
        assert(data.custom.every(m => m.status === 'ok'), 'Script-scope assertions must not be swallowed as command errors');
        assert.deepEqual(instance.getCachedStats(session).custom.map(m => m.id), data.custom.map(m => m.id));
    }
});

test('scope: unmatched, deleted and explicitly empty selections execute no value or detail commands', async () => {
    const inputs = [
        metric({ id: 'other', displayScope: selected('P2'), detailCommand: 'printf hidden' }),
        metric({ id: 'deleted', displayScope: selected('removed'), detailCommand: 'printf hidden' }),
        metric({ id: 'empty', displayScope: selected(), detailCommand: 'printf hidden' }),
    ];
    const { instance, session } = service(inputs, [], { profiles: saved('P1', 'P2') });
    session.profile = { id: 'P1' };
    let calls = 0;
    instance.execute = async () => { calls++; throw new Error('Hidden commands must never be executed'); };
    assert.deepEqual((await instance.fetchStats(session)).custom, []);
    assert.deepEqual(await instance.fetchDetails(session, inputs), {});
    assert.equal(calls, 0);
});

test('scope: whole group inherits its selected layout and ignores nested member overrides', async () => {
    const group = { id: 'group', displayScope: selected('layout-A'),
        main: metric({ id: 'main', displayScope: selected('unrelated') }),
        children: [metric({ id: 'child', displayScope: selected() })] };
    const scopes = { contextForSession: session => ({ profileIds: [session.profile.id, ...(session.layouts || [])] }) };
    const { instance } = service([], [group], { profiles: saved('P1', 'P2', 'layout-A'), scopes });
    let calls = 0;
    instance.execute = async (_session, script) => { calls++; return echoPackets(script); };
    for (const id of ['P1', 'P2']) {
        const data = await instance.fetchStats({ open: true, profile: { id }, layouts: ['layout-A'] });
        assert.deepEqual(data.custom.map(m => m.id), ['main', 'child']);
    }
    assert.deepEqual((await instance.fetchStats({ open: true, profile: { id: 'P1' } })).custom, []);
    assert.equal(calls, 2);
});

test('scope: deleting a selected profile invalidates cached results without broadening to a same-name profile', async () => {
    const input = metric({ displayScope: selected('original'), detailCommand: 'printf details' });
    const { instance, config, session } = service([input], [], { profiles: [{ id: 'original', name: 'P1' }] });
    session.profile = { id: 'original' };
    let calls = 0;
    instance.execute = async (_session, script) => { calls++; return echoPackets(script); };
    await instance.fetchStats(session);
    assert.equal(instance.getCachedStats(session).custom.length, 1);
    config.store.profiles = [{ id: 'replacement', name: 'P1' }];
    assert.equal(instance.getCachedStats(session), null);
    assert.deepEqual((await instance.fetchStats(session)).custom, []);
    assert.deepEqual(await instance.fetchDetails(session, [input]), {});
    assert.equal(calls, 1);
});

test('scope: moving a pane between layouts drops an old in-flight collection and starts the new scope', async () => {
    const scopes = { contextForSession: session => ({ profileIds: [session.layout] }) };
    const { instance, session } = service([
        metric({ id: 'a', command: 'printf SCOPE_A', displayScope: selected('layout-A') }),
        metric({ id: 'b', command: 'printf SCOPE_B', displayScope: selected('layout-B') }),
    ], [], { profiles: saved('layout-A', 'layout-B'), scopes });
    session.layout = 'layout-A';
    let finishA, events = [];
    instance.statsUpdated$.subscribe(event => events.push(event.stats));
    instance.execute = async (_session, script) => script.includes('SCOPE_A') ? new Promise(resolve => { finishA = resolve; }) : packet('ok', 'B');
    const pendingA = instance.fetchStats(session);
    session.layout = 'layout-B';
    assert.equal((await instance.fetchStats(session)).custom[0].value, 'B');
    finishA(packet('ok', 'A'));
    assert.equal(await pendingA, null);
    assert.equal(instance.getCachedStats(session).custom[0].value, 'B');
    assert(events.every(event => event.custom.every(m => m.id === 'b')));
});

test('scope: a changed layout discards delayed hover data and blocks details waiting on old collection', async () => {
    const scopes = { contextForSession: session => ({ profileIds: [session.layout] }) };
    const input = metric({ displayScope: selected('layout-A'), detailCommand: 'printf details' });
    for (const waitingOnCollection of [false, true]) {
        const { instance, session } = service([input], [], { profiles: saved('layout-A', 'layout-B'), scopes });
        session.layout = 'layout-A';
        let finish, calls = 0;
        instance.execute = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
        const collection = waitingOnCollection ? instance.fetchStats(session) : null;
        const detail = instance.fetchDetails(session, [input]);
        session.layout = 'layout-B';
        finish(packet('ok', 'late', waitingOnCollection ? 'm_0' : 'detail'));
        if (collection) assert.equal(await collection, null);
        assert.deepEqual(await detail, {});
        assert.equal(calls, 1);
        assert.equal(instance.getCachedStats(session), null);
    }
});
