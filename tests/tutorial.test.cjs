const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/tutorial.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

function fixture(options = {}) {
    const exports = {}, modules = [], checked = [], opened = []
    vm.runInNewContext(source, {
        exports, __dirname: options.dirname || 'C:\\Tabby plugins\\实验室\\tabby-group-server-stats/dist',
        require(name) {
            modules.push(name)
            if (name === 'path') return options.path || path.win32
            if (name === 'fs') return { existsSync(filename) {
                checked.push(filename)
                return options.exists ? options.exists(filename) : true
            } }
            if (name === 'electron') return { shell: { openPath(filename) {
                opened.push(filename)
                return options.open ? options.open(filename) : Promise.resolve('')
            } } }
            throw Error(`Unexpected dependency: ${name}`)
        },
    })
    return { ...exports, modules, checked, opened }
}

test('tutorial loads native dependencies only on demand and normalizes the Windows path', async () => {
    const f = fixture({ dirname: 'C:\\Tabby plugins\\实验室\\old/../tabby-group-server-stats\\dist' })
    assert.deepEqual(f.modules, [])
    await f.openTutorialPdf('zh-CN')
    const expected = 'C:\\Tabby plugins\\实验室\\tabby-group-server-stats\\docs\\tutorial.zh-CN.pdf'
    assert.deepEqual(f.checked, [expected])
    assert.deepEqual(f.opened, [expected])
    assert(path.win32.isAbsolute(expected))
    assert(!f.opened[0].includes('/'))
    assert(!f.opened[0].includes('..'))
})

test('tutorial chooses Chinese for zh locales and English for other languages', async () => {
    const f = fixture({ path: path.posix, dirname: '/opt/tabby plugins/插件/dist' })
    for (const locale of ['zh-CN', 'zh-TW', 'ZH-hans', 'en-US', 'de', '']) await f.openTutorialPdf(locale)
    assert.deepEqual(f.opened.map(filename => path.posix.basename(filename)), [
        'tutorial.zh-CN.pdf', 'tutorial.zh-CN.pdf', 'tutorial.zh-CN.pdf',
        'tutorial.en.pdf', 'tutorial.en.pdf', 'tutorial.en.pdf',
    ])
    assert(f.opened.every(filename => filename.startsWith('/opt/tabby plugins/插件/docs/')))
})

test('tutorial resolves to the existing packaged PDFs relative to the bundle directory', async () => {
    const f = fixture({ dirname: path.resolve(__dirname, '../dist'), path, exists: fs.existsSync })
    await f.openTutorialPdf('zh-CN')
    await f.openTutorialPdf('en')
    assert.deepEqual(f.opened, [path.resolve(__dirname, '../docs/tutorial.zh-CN.pdf'), path.resolve(__dirname, '../docs/tutorial.en.pdf')])
})

test('missing tutorial reports a specific error without invoking the native shell', async () => {
    const f = fixture({ exists: () => false })
    await assert.rejects(f.openTutorialPdf('zh-CN'), error => error instanceof f.TutorialOpenError && error.code === 'missing')
    assert.deepEqual(f.opened, [])
    assert(!f.modules.includes('electron'))
})

test('tutorial waits for the native shell outcome', async () => {
    let finish
    const f = fixture({ open: () => new Promise(resolve => { finish = resolve }) })
    let completed = false
    const pending = f.openTutorialPdf('en').then(() => { completed = true })
    await Promise.resolve()
    assert.equal(completed, false)
    finish('')
    await pending
    assert.equal(completed, true)
})

for (const [name, open] of [
    ['nonempty native error string', () => Promise.resolve('No application is associated with this file')],
    ['rejected native promise', () => Promise.reject(Error('Viewer could not start'))],
    ['synchronous native exception', () => { throw Error('Shell is unavailable') }],
]) {
    test(`tutorial reports ${name} as openFailed`, async () => {
        const f = fixture({ open })
        await assert.rejects(f.openTutorialPdf('en'), error => error instanceof f.TutorialOpenError && error.code === 'openFailed')
        assert.equal(f.opened.length, 1)
    })
}

test('filesystem inspection failure is reported instead of silently ignoring the click', async () => {
    const f = fixture({ exists: () => { throw Error('File inspection failed') } })
    await assert.rejects(f.openTutorialPdf('en'), error => error instanceof f.TutorialOpenError && error.code === 'openFailed')
    assert.deepEqual(f.opened, [])
})
