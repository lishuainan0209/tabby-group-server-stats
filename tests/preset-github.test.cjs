const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 }
}).outputText, filename)
const { DEFAULT_GITHUB_PRESETS_URL, GITHUB_PRESETS_MAX_BYTES, resolveGitHubPresetUrl, fetchGitHubPresets, PresetGitHubError } = require('../src/preset-github.ts')
const metric = { label: 'GPU', command: 'printf 42', type: 'text' }
const legacy = [metric, { label: 'Legacy', command: 'printf "$HOME"' }]
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'text/plain' } })
const expectedCode = code => error => error instanceof PresetGitHubError && error.code === code

test('GitHub URLs default to this fork and normalize blob links without query credentials', () => {
    assert.equal(resolveGitHubPresetUrl(), DEFAULT_GITHUB_PRESETS_URL)
    assert.equal(resolveGitHubPresetUrl('  '), DEFAULT_GITHUB_PRESETS_URL)
    assert.equal(resolveGitHubPresetUrl('https://github.com/team/repo/blob/main/folder/presets.json?raw=1#L2'), 'https://raw.githubusercontent.com/team/repo/main/folder/presets.json')
    assert.equal(resolveGitHubPresetUrl('https://raw.githubusercontent.com/team/repo/feature/branch/presets.json?token=not-forwarded'), 'https://raw.githubusercontent.com/team/repo/feature/branch/presets.json')
    assert.equal(resolveGitHubPresetUrl('https://github.com:443/team/repo/blob/v1/presets.json'), 'https://raw.githubusercontent.com/team/repo/v1/presets.json')
    for (const url of ['http://github.com/team/repo/blob/main/presets.json', 'https://github.com.evil.test/team/repo/blob/main/presets.json',
        'https://example.com/presets.json', 'file:///tmp/presets.json', 'https://username:password@github.com/team/repo/blob/main/presets.json',
        'https://github.com:8443/team/repo/blob/main/presets.json', 'https://github.com/team/repo/tree/main',
        'https://github.com/team/repo/blob/main/script.sh', 'https://raw.githubusercontent.com/team/repo/main/presets.json/%00.json', 'not a URL']) {
        assert.throws(() => resolveGitHubPresetUrl(url), expectedCode('invalid-url'), url)
    }
})

test('download is a credential-free GET and returns normalized legacy arrays without mutating existing data', async () => {
    const existing = [{ id: 'local', kind: 'metric', label: 'Local', metric: { id: 'local', type: 'text', command: 'printf LOCAL' } }]
    const before = JSON.stringify(existing)
    const requests = []
    const imported = await fetchGitHubPresets(undefined, { fetch: async (url, init) => { requests.push({ url, init }); return response(legacy) } })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, DEFAULT_GITHUB_PRESETS_URL)
    assert.equal(requests[0].init.method, 'GET')
    assert.equal(requests[0].init.credentials, 'omit')
    assert.equal(requests[0].init.redirect, 'error')
    assert.equal(requests[0].init.referrerPolicy, 'no-referrer')
    assert.equal(requests[0].init.body, undefined)
    assert.deepEqual(Object.keys(requests[0].init.headers), ['Accept'])
    assert.equal(imported.length, 2)
    assert.equal(imported[1].kind, 'metric')
    assert.equal(imported[1].metric.type, 'text')
    assert.equal(imported[1].metric.command, 'printf "$HOME"')
    assert.equal(JSON.stringify(existing), before)
    imported[0].metric.command = 'draft'
    assert.equal(legacy[0].command, 'printf 42')
})

test('group libraries retain commands, metadata and portable target names as data', async () => {
    const group = { id: 'gpu', kind: 'group', label: 'GPU', labels: { en: 'GPU memory', zh: 'GPU 显存' }, profileNames: [' P3(ai) '],
        source: { name: 'Lab', license: 'MIT' }, group: { id: 'gpu-group', mode: 'overview', layout: 'vertical',
            main: { id: 'main', ...metric }, children: [{ id: 'child', ...metric, visibleWhenUnavailable: false }] } }
    const imported = await fetchGitHubPresets(undefined, { fetch: async () => response({ presets: [group] }) })
    assert.equal(imported[0].group.children[0].visibleWhenUnavailable, false)
    assert.equal(imported[0].group.main.command, 'printf 42')
    assert.deepEqual(imported[0].profileNames, ['P3(ai)'])
    assert.equal(imported[0].source.license, 'MIT')
    assert.equal(imported[0].labels.zh, 'GPU 显存')
})

test('HTTP, JSON, schema and network failures have distinct stable error codes', async () => {
    await assert.rejects(fetchGitHubPresets(undefined, { fetch: async () => new Response('Not found', { status: 404 }) }), error => error.code === 'http' && error.status === 404)
    await assert.rejects(fetchGitHubPresets(undefined, { fetch: async () => new Response('<html>no JSON</html>') }), expectedCode('invalid-json'))
    await assert.rejects(fetchGitHubPresets(undefined, { fetch: async () => response({ unexpected: true }) }), expectedCode('invalid-library'))
    await assert.rejects(fetchGitHubPresets(undefined, { fetch: async () => response([{ kind: 'group', group: {} }]) }), expectedCode('invalid-library'))
    await assert.rejects(fetchGitHubPresets(undefined, { fetch: async () => { throw new TypeError('offline or blocked redirect') } }), expectedCode('network'))
    let called = false
    await assert.rejects(fetchGitHubPresets('https://localhost/presets.json', { fetch: async () => { called = true; return response([]) } }), expectedCode('invalid-url'))
    assert.equal(called, false)
})

test('response size limits are enforced for declared and chunked bodies before JSON parsing', async () => {
    let canceled = false
    const oversized = new Response(new ReadableStream({ cancel() { canceled = true } }), { headers: { 'Content-Length': String(GITHUB_PRESETS_MAX_BYTES + 1) } })
    await assert.rejects(fetchGitHubPresets(undefined, { maxBytes: Infinity, fetch: async () => oversized }), expectedCode('too-large'))
    assert.equal(canceled, true)
    let delivered = 0, streamCanceled = false
    const chunked = new Response(new ReadableStream({
        pull(controller) { delivered++; controller.enqueue(new Uint8Array(16).fill(32)) },
        cancel() { streamCanceled = true }
    }))
    await assert.rejects(fetchGitHubPresets(undefined, { maxBytes: 24, fetch: async () => chunked }), expectedCode('too-large'))
    assert.equal(streamCanceled, true)
    assert(delivered <= 4, 'The reader stops early instead of buffering the whole stream')
})

test('UTF-8 split across response chunks is intact and malformed encoding is rejected', async () => {
    const bytes = Buffer.from(JSON.stringify([{ ...metric, label: '显存😀' }]))
    const split = bytes.indexOf(Buffer.from('显')) + 1
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, split)); controller.enqueue(bytes.subarray(split)); controller.close() } })
    const imported = await fetchGitHubPresets(undefined, { fetch: async () => new Response(body) })
    assert.equal(imported[0].label, '显存😀')
    await assert.rejects(fetchGitHubPresets(undefined, { fetch: async () => new Response(Uint8Array.from([91, 34, 255, 34, 93])) }), expectedCode('invalid-json'))
})

test('one timeout bounds both a stuck fetch and a stalled body even when mocks ignore abort', async () => {
    let fetchSignal
    await assert.rejects(fetchGitHubPresets(undefined, { timeoutMs: 20, fetch: async (_, init) => {
        fetchSignal = init.signal
        return await new Promise(() => {})
    } }), expectedCode('timeout'))
    assert.equal(fetchSignal.aborted, true)
    let canceled = false
    await assert.rejects(fetchGitHubPresets(undefined, { timeoutMs: 20, fetch: async () => new Response(new ReadableStream({ cancel() { canceled = true } })) }), expectedCode('timeout'))
    assert.equal(canceled, true)
})

test('caller cancellation aborts the request and an already canceled call sends nothing', async () => {
    const controller = new AbortController()
    const task = fetchGitHubPresets(undefined, { signal: controller.signal, fetch: async () => new Promise(() => {}) })
    controller.abort()
    await assert.rejects(task, expectedCode('aborted'))
    let called = false
    await assert.rejects(fetchGitHubPresets(undefined, { signal: controller.signal, fetch: async () => { called = true; return response([]) } }), expectedCode('aborted'))
    assert.equal(called, false)
})
