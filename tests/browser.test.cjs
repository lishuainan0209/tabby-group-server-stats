const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const webpack = require('webpack')
const { chromium } = require('playwright-core')

async function main() {
    await new Promise((resolve, reject) => webpack(require('./browser/webpack.cjs'), (error, stats) => {
        if (error || stats.hasErrors()) reject(error || Error(stats.toString({ all: false, errors: true })))
        else resolve()
    }))
    const bundle = fs.readFileSync(path.join(__dirname, '../.test-ui/harness.js'))
    const hostTheme = process.env.HOST_THEME_CSS ? fs.readFileSync(process.env.HOST_THEME_CSS) : ''
    const server = http.createServer((req, res) => {
        if (req.url === '/harness.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle) }
        else if (req.url === '/host-theme.css') { res.setHeader('Content-Type', 'text/css'); res.end(hostTheme) }
        else res.end('<!doctype html><html data-bs-theme="dark" style="--theme-bg:#171717;--theme-fg:#ddd;--bs-body-bg:#171717;--bs-body-color:#ddd"><meta charset="UTF-8"><link rel="stylesheet" href="/host-theme.css"><style>body{margin:30px;background:#11151c;color:#ddd;font-family:Segoe UI,Microsoft YaHei,sans-serif;overflow:auto!important}*{box-sizing:border-box}test-app{display:block}</style><test-app></test-app><script src="/harness.js"></script></html>')
    })
    // Some Windows ephemeral-port ranges include Chromium's blocked ports.
    await new Promise((resolve, reject) => {
        let port = 38300
        const listen = () => server.listen(port, '127.0.0.1', resolve)
        server.on('error', error => error.code === 'EADDRINUSE' && port++ < 38330 ? listen() : reject(error))
        listen()
    })
    const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true })
    try {
        const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
        const errors = []
        const externalRequests = []
        const githubPresetUrl = 'https://raw.githubusercontent.com/lishuainan0209/tabby-group-server-stats/main/presets.json'
        let mockedGithubHttpFailure = false
        page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:')) externalRequests.push(request.url()) })
        page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message) })
        page.on('console', msg => {
            if (msg.type() !== 'error') return
            // Chromium reports our intentional HTTP 503 mock as a resource error.
            // Only that exact URL/status is expected; application errors still fail.
            if (mockedGithubHttpFailure && msg.location().url === githubPresetUrl && /Failed to load resource:.*503/.test(msg.text())) return
            errors.push(msg.text()); console.error('Browser console:', msg.text())
        })
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        await page.waitForFunction(() => window.ready, null, { timeout: 15000 })
        const mutate = async fn => page.evaluate(`(${fn})(); window.tick()`)
        const assertVisibleBorders = async (locator, label) => {
            const styles = await locator.evaluateAll(nodes => nodes.map(node => {
                const css = getComputedStyle(node)
                return { name: node.className, borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => ({
                    width: parseFloat(css[`border${side}Width`]), style: css[`border${side}Style`], color: css[`border${side}Color`],
                })), background: css.backgroundColor }
            }))
            assert(styles.length > 0, `${label}: expected rendered elements`)
            for (const style of styles) for (const border of style.borders) {
                assert(border.width >= 2, `${label}: ${style.name} needs a border of at least 2px`)
                assert(!['none', 'hidden'].includes(border.style), `${label}: border must have a visible line style`)
                assert.notEqual(border.color, style.background, `${label}: border must differ from its background`)
                assert.notEqual(border.color, 'transparent', `${label}: border must not be transparent`)
                const rgba = border.color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/)
                if (rgba) assert(Number(rgba[1]) >= 0.35, `${label}: border opacity must remain clearly visible`)
            }
        }
        const group = page.locator('.metric-group')
        const firstWidth = (await group.boundingBox()).width
        assert.equal(await group.locator('.group-label').count(), 0)
        await page.waitForFunction(() => document.querySelector('.carousel-active').textContent.includes('Not mounted'))
        assert(!/Not mounted\s*%/.test(await group.innerText()), 'Failure text must not gain a numeric suffix')
        assert(Math.abs((await group.boundingBox()).width - firstWidth) < 1, 'Carousel width stays fixed when a longer failure message rotates in')
        console.log('PASS default failed child is visible in actual carousel')
        await mutate(() => { const h = window.harness; h.group = { ...h.group, interval: 1, children: h.group.children.map(m => ({ ...m, showWhenUnavailable: m.id !== 'b' })) } })
        await page.waitForFunction(() => document.querySelector('.carousel-active').textContent.includes('/data3'), null, { timeout: 2500 })
        assert(!(await group.innerText()).includes('Not mounted'))
        console.log('PASS per-child opt-out skips failure without another cycle')
        await group.hover()
        await page.waitForFunction(() => document.querySelector('.group-details')?.textContent.includes('可用'))
        const popupBox = await page.locator('.group-details').boundingBox()
        const groupBox = await group.boundingBox()
        assert(popupBox.y >= 0 && popupBox.y + popupBox.height <= groupBox.y + 1, 'Popover must stay above blurred status bar, inside viewport')
        await page.locator('.group-details').hover()
        assert.equal(await page.locator('.group-details').count(), 1, 'Moving into popup must keep it open')
        assert((await page.locator('.group-details').innerText()).includes('Not mounted'), 'Expanded view must preserve hidden carousel failures')
        assert.equal(await page.locator('.group-details .metric-detail').count(), 3)
        assert.equal((await page.locator('.details-title').innerText()).trim(), '磁盘')
        const readings = await page.locator('.group-details .metric-reading').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().right))
        assert(readings.every(x => Math.abs(x - readings[0]) < 1), 'All primary values share a right-aligned column')
        const details = await page.locator('.group-details .metric-detail').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().left))
        assert(details.every(x => Math.abs(x - details[0]) < 1), 'All hover details share a column')
        const indents = await page.locator('.group-details .metric-label').evaluateAll(nodes => nodes.map(n => parseFloat(getComputedStyle(n).paddingLeft)))
        assert.equal(indents[0], 0)
        assert(indents.slice(1).every(x => x >= 16))
        console.log('PASS group title is popup-only, with indented children and aligned value/detail columns')
        const compactPopup = await page.locator('.group-details').evaluate(node => ({
            width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
            fits: node.scrollWidth <= Math.ceil(node.getBoundingClientRect().width),
            gap: parseFloat(getComputedStyle(node.querySelector('.detail-grid')).rowGap),
            separators: [...node.querySelectorAll('.metric-detail')].map(detail => ({
                width: parseFloat(getComputedStyle(detail).borderLeftWidth), style: getComputedStyle(detail).borderLeftStyle,
            })),
        }))
        assert(compactPopup.width < 440, 'Short fixture content must not reserve the old 480px-wide popup')
        assert(compactPopup.height < 180, 'Four short rows should remain compact')
        assert(compactPopup.fits, 'Compact popup must retain all content')
        assert.equal(compactPopup.gap, 4)
        assert(compactPopup.separators.every(line => line.width === 1 && line.style === 'solid'))
        console.log('PASS compact popup sizes to content, retains aligned rows and uses thin detail separators')
        if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT })
        await page.mouse.move(1040, 650)
        await page.waitForFunction(() => !document.querySelector('.group-details'))
        console.log('PASS overview/carousel expansion includes all rows and valid details')
        await mutate(() => { window.harness.group = { ...window.harness.group, mode: 'overview' } })
        assert((await group.innerText()).includes('总览'))
        assert(!(await group.innerText()).includes('/data1'))
        await group.hover()
        await page.waitForFunction(() => document.querySelector('.group-details')?.textContent.includes('/data1'))
        await mutate(() => { window.harness.detailResults = { main: 'Err: No result', a: 'Err: Exit 2' } })
        await page.waitForFunction(() => document.querySelector('.group-details .detail-error')?.textContent.includes('No detail received'))
        assert(!(await page.locator('.group-details').innerText()).includes('Err:'))
        const errorColors = await page.locator('.group-details .detail-error').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).color))
        assert(errorColors.every(c => c === 'rgb(255, 0, 0)'))
        assert.equal(await page.locator('.group-details .metric-value').first().evaluate(n => getComputedStyle(n).color), 'rgb(0, 255, 0)')
        console.log('PASS detail errors have readable messages and independent error colors')
        if (process.env.DETAIL_SCREENSHOT) {
            await mutate(() => { window.harness.previewChinese = true })
            await page.screenshot({ path: process.env.DETAIL_SCREENSHOT })
            await mutate(() => { window.harness.previewChinese = false })
        }
        await mutate(() => { window.harness.detailResults = {} })
        await page.mouse.move(1040, 650)
        await page.waitForFunction(() => !document.querySelector('.group-details'))
        console.log('PASS overview shows main result and expands the full group')
        await mutate(() => { window.harness.group = { ...window.harness.group, mode: 'static', layout: 'horizontal' }; window.harness.detailCalls = [] })
        await page.locator('.metric-group .metric-row').nth(1).hover()
        await page.waitForFunction(() => document.querySelector('.metric-group .metric-detail')?.textContent.includes('可用'))
        assert.equal(await page.locator('.metric-group .metric-detail').count(), 1)
        console.log('PASS horizontal hover expands only its own row')
        await page.mouse.move(1040, 650)
        await mutate(() => { window.harness.group = { ...window.harness.group, layout: 'vertical' } })
        await group.hover()
        await page.waitForFunction(() => [...document.querySelectorAll('.metric-group .metric-detail')].filter(x => x.textContent.includes('可用')).length === 3)
        console.log('PASS vertical hover expands every valid row')
        await page.mouse.move(1040, 650)
        await mutate(() => { window.harness.detailDelay = 300 })
        await page.locator('.single').hover()
        await page.mouse.move(1040, 650)
        await page.waitForTimeout(400)
        assert.equal(await page.locator('.single .metric-detail').count(), 0)
        console.log('PASS late detail responses do not reopen a departed hover')
        await mutate(() => {
            const h = window.harness
            h.detailDelay = 0
            h.group = { ...h.group, mode: 'carousel', children: h.group.children.map(m => ({ ...m, showWhenUnavailable: true })) }
        })
        const fixedWidth = (await group.boundingBox()).width
        await mutate(() => { const h = window.harness; h.stats = { custom: h.stats.custom.map(r => r.id === 'a' ? { ...r, value: '完整内容'.repeat(40) } : r) } })
        await page.waitForFunction(() => document.querySelector('.carousel-active')?.textContent.includes('完整内容'))
        assert(Math.abs((await group.boundingBox()).width - fixedWidth) < 1)
        const longValue = page.locator('.carousel-active .metric-value')
        assert((await longValue.innerText()).includes('完整内容'.repeat(40)))
        assert(await longValue.evaluate(n => n.scrollWidth <= Math.ceil(n.getBoundingClientRect().width) + 1))
        assert((await longValue.boundingBox()).height > 25)
        console.log('PASS later longer carousel results wrap completely without changing width')
        await mutate(() => {
            document.querySelector('.bar').style.width = '260px'
            const h = window.harness
            h.group = { ...h.group, children: h.group.children.map(m => m.id === 'a' ? { ...m, label: '很长的磁盘标签'.repeat(8) } : m) }
        })
        await page.waitForFunction(() => document.querySelector('.carousel-active')?.textContent.includes('很长的磁盘标签'))
        const paneBar = await page.locator('.bar').boundingBox()
        const narrowGroup = await group.boundingBox()
        assert(narrowGroup.x + narrowGroup.width <= paneBar.x + paneBar.width + 1)
        assert(await page.locator('.carousel-active .metric-label').evaluate(n => n.scrollWidth <= Math.ceil(n.getBoundingClientRect().width) + 1))
        await mutate(() => {
            document.querySelector('.bar').style.width = ''
            const h = window.harness
            h.group = { ...h.group, children: h.group.children.map(m => m.id === 'a' ? { ...m, label: '/data1' } : m) }
        })
        console.log('PASS carousel contents wrap within a narrow split pane without horizontal overflow')
        await mutate(() => { const h = window.harness; h.stats = { custom: h.stats.custom.map(r => r.id === 'a' ? { ...r, value: '52' } : r) } })
        await mutate(() => {
            const h = window.harness
            h.group = { ...h.group, mode: 'carousel', children: h.group.children.map(m => ({ ...m, showWhenUnavailable: false })) }
            h.stats = { custom: h.stats.custom.map(r => ({ ...r, status: 'unavailable', value: '未挂载' })) }
        })
        assert((await group.innerText()).includes('No available items'))
        await group.hover()
        await page.waitForFunction(() => document.querySelectorAll('.group-details .detail-row').length === 4)
        assert.equal(await page.locator('.group-details .metric-detail').count(), 0)
        await page.mouse.move(1040, 650)
        console.log('PASS all hidden failures use an empty summary but remain in expanded details')
        await mutate(() => {
            const h = window.harness
            h.metrics = h.metrics.map(m => ({ ...m, enabled: false }))
            h.group = { ...h.group, enabled: false }
        })
        assert.equal(await page.locator('.bar .single').count(), 0)
        assert.equal(await page.locator('.bar .metric-group').count(), 0)
        await mutate(() => {
            const h = window.harness
            h.metrics = h.metrics.map(m => ({ ...m, enabled: true }))
            h.stats = { custom: h.stats.custom.map(r => ({ ...r, status: r.id === 'b' ? 'unavailable' : 'ok', value: r.id === 'b' ? '未挂载' : '42' })) }
            h.group = { ...h.group, enabled: true, mode: 'static', layout: 'vertical', main: { ...h.group.main, enabled: false },
                children: h.group.children.map(m => ({ ...m, enabled: m.id !== 'a', visibleWhenUnavailable: m.id !== 'b', showWhenUnavailable: true })) }
        })
        assert.equal(await page.locator('.bar .single').count(), 1)
        assert.equal(await group.locator('.metric-row').count(), 1)
        assert((await group.innerText()).includes('/data3'))
        assert(await group.locator('.metric-label').evaluate(n => parseFloat(getComputedStyle(n).paddingLeft) >= 12))
        console.log('PASS standalone/group/member disable switches hide output while surviving children retain indentation')
        await mutate(() => { const h = window.harness; h.group = { ...h.group, mode: 'overview' } })
        await group.hover()
        await page.waitForFunction(() => document.querySelector('.group-details'))
        assert.equal(await page.locator('.group-details .detail-row').count(), 1)
        assert(!(await page.locator('.group-details').innerText()).includes('/data2'))
        assert(await page.locator('.group-details .metric-label').evaluate(n => parseFloat(getComputedStyle(n).paddingLeft) >= 16))
        await page.mouse.move(1040, 650)
        await page.waitForFunction(() => !document.querySelector('.group-details'))
        await mutate(() => { const h = window.harness; h.group = { ...h.group, mode: 'carousel' } })
        assert.equal(await page.locator('.carousel-measure').count(), 1)
        assert((await page.locator('.carousel-active').innerText()).includes('/data3'))
        await mutate(() => { const h = window.harness; h.stats = { custom: h.stats.custom.map(r => r.id === 'b' ? { ...r, status: 'ok', value: '55' } : r) } })
        await page.waitForFunction(() => document.querySelector('.carousel-active')?.textContent.includes('/data2'), null, { timeout: 2500 })
        assert.equal(await page.locator('.carousel-measure').count(), 2)
        await group.hover()
        await page.waitForFunction(() => document.querySelectorAll('.group-details .detail-row').length === 2)
        assert((await page.locator('.group-details').innerText()).includes('55%'))
        await page.mouse.move(1040, 650)
        await page.waitForFunction(() => !document.querySelector('.group-details'))
        console.log('PASS hidden failures stay out of static/popup/carousel views and return after a successful sample')
        await mutate(() => {
            const h = window.harness
            h.ratioPreviewSnapshot = { metrics: h.metrics, group: h.group, stats: h.stats, detailResults: h.detailResults }
            h.metrics = []
            const metric = (id, label) => ({ id, label, command: 'printf 1', type: 'text', suffix: 'GiB', detailCommand: 'printf details' })
            h.group = { id: 'disk-ratios', label: 'P3磁盘', mode: 'overview', layout: 'vertical',
                main: metric('disk-total', '磁盘总余量'), children: [metric('disk-root', '系统盘'), metric('disk-data', '/data'), metric('disk-other', '/lsn_disk1')] }
            h.stats = { custom: [
                { id: 'disk-total', status: 'ok', value: '551' }, { id: 'disk-root', status: 'ok', value: '38' },
                { id: 'disk-data', status: 'ok', value: '87' }, { id: 'disk-other', status: 'ok', value: '425' },
            ] }
            h.detailResults = { 'disk-total': '551.0/8786.0 GiB', 'disk-root': '38.3/936.4 GiB',
                'disk-data': '87.3/7392.2 GiB', 'disk-other': '425.4/457.4 GiB' }
        })
        await group.hover()
        await page.waitForFunction(() => document.querySelectorAll('.group-details .ratio-numerator').length === 4)
        const assertRatioColumns = async container => {
            for (const selector of ['.metric-value', '.ratio-numerator', '.ratio-slash', '.ratio-denominator', '.ratio-unit']) {
                const edges = await container.locator(selector).evaluateAll(nodes => nodes.map(node => {
                    const range = document.createRange()
                    range.selectNodeContents(node)
                    return range.getBoundingClientRect().right
                }))
                assert.equal(edges.length, 4, `Four disk rows must render ${selector}`)
                assert(edges.every(edge => Math.abs(edge - edges[0]) < 1), `${selector}: actual text must share a right edge across rows`)
            }
            const numerators = await container.locator('.ratio-numerator').allTextContents()
            assert.deepEqual(numerators.map(value => value.trim()), ['551.0', '38.3', '87.3', '425.4'])
            const denominators = await container.locator('.ratio-denominator').allTextContents()
            assert.deepEqual(denominators.map(value => value.trim()), ['8786.0', '936.4', '7392.2', '457.4'])
        }
        await assertRatioColumns(page.locator('.group-details'))
        if (process.env.RATIO_SCREENSHOT) await page.screenshot({ path: process.env.RATIO_SCREENSHOT })
        await page.mouse.move(1040, 650)
        await mutate(() => { window.harness.group = { ...window.harness.group, mode: 'static' } })
        await group.hover()
        await page.waitForFunction(() => document.querySelectorAll('.metric-group .ratio-numerator').length === 4)
        await assertRatioColumns(group)
        assert((await group.boundingBox()).height <= 55, 'Four static disk rows stay compact even with expanded capacity details')
        await mutate(() => {
            window.harness.detailResults = { 'disk-total': '551.0/8786.0 GiB', 'disk-root': '38.3/936.4GB',
                'disk-data': '87.3/7392.2 GiB', 'disk-other': '425.4/457.4' }
        })
        await page.waitForFunction(() => [...document.querySelectorAll('.metric-group .ratio-unit')].some(node => node.textContent.trim() === 'GB'))
        for (const selector of ['.ratio-numerator', '.ratio-slash', '.ratio-denominator']) {
            const edges = await group.locator(selector).evaluateAll(nodes => nodes.map(node => {
                const range = document.createRange(); range.selectNodeContents(node)
                return range.getBoundingClientRect().right
            }))
            assert.equal(edges.length, 4)
            assert(edges.every(edge => Math.abs(edge - edges[0]) < 1), `${selector}: mixed or absent units must not displace numeric columns`)
        }
        assert.deepEqual((await group.locator('.ratio-unit').allTextContents()).map(value => value.trim()).filter(Boolean), ['GiB', 'GB', 'GiB'])
        await page.mouse.move(1040, 650)
        await mutate(() => {
            const h = window.harness, snapshot = h.ratioPreviewSnapshot
            h.metrics = snapshot.metrics; h.group = snapshot.group; h.stats = snapshot.stats; h.detailResults = snapshot.detailResults
            delete h.ratioPreviewSnapshot
        })
        console.log('PASS disk values and both sides of capacity ratios align independently in popups and compact static groups')
        await mutate(() => {
            const h = window.harness
            h.networkPreviewSnapshot = { metrics: h.metrics, group: h.group, stats: h.stats, detailResults: h.detailResults,
                previewChinese: h.previewChinese, language: h.config.store.language }
            h.metrics = []
            h.group = { id: 'builtin-net', label: 'Network', mode: 'static', layout: 'vertical',
                main: { id: 'builtin-net-main', label: 'Network', command: 'printf 0', type: 'text', enabled: false },
                children: ['rx', 'tx'].map((direction, index) => ({ id: `builtin-net-${direction}`,
                    label: index ? 'Upload' : 'Download', command: 'printf 1', detailCommand: 'printf details', type: 'text', suffix: 'KiB/s',
                    colorRules: [{ operator: '>', value: 10000, color: '#ff0000' }, { operator: '>', value: 0.5, color: '#ffa500' }] })) }
            h.stats = { custom: [{ id: 'builtin-net-rx', status: 'ok', value: '0.819336' }, { id: 'builtin-net-tx', status: 'ok', value: '12345.678' }] }
            h.detailResults = { 'builtin-net-rx': 'Received total: 201.900 GiB (since interface reset; eth0)',
                'builtin-net-tx': 'Sent total: 35.600 GiB (since interface reset; eth0)' }
            h.previewChinese = true; h.config.store.language = 'zh-CN'
        })
        const staticHeight = (await group.boundingBox()).height
        assert(staticHeight <= 27, `Two static network rows must occupy at most 27px, got ${staticHeight}`)
        assert.equal(await group.evaluate(node => getComputedStyle(node).rowGap), '0px')
        const separator = await group.locator('.metric-row + .metric-row').evaluate(node => {
            const css = getComputedStyle(node, '::before')
            return { height: css.height, columnStart: css.gridColumnStart, columnEnd: css.gridColumnEnd, background: css.backgroundColor }
        })
        assert.equal(separator.height, '1px')
        assert.equal(separator.columnStart, '1')
        assert.equal(separator.columnEnd, '-1')
        assert.notEqual(separator.background, 'rgba(0, 0, 0, 0)', 'Static rows need a visible full-width thin separator')
        await group.hover()
        await page.waitForFunction(() => document.querySelector('.metric-group .metric-detail')?.textContent.includes('累计接收'))
        const networkDetails = group.locator('.metric-detail')
        assert.deepEqual((await networkDetails.allTextContents()).map(value => value.replace(/\s+/g, '')),
            ['累计接收201.900GiB', '累计发送35.600GiB'])
        assert.deepEqual(await networkDetails.evaluateAll(nodes => nodes.map(node => node.title)),
            ['自网卡建立或计数器重置起 · eth0', '自网卡建立或计数器重置起 · eth0'])
        assert((await group.innerText()).includes('0.001 MB/s'))
        assert((await group.innerText()).includes('12.642 MB/s'))
        assert.deepEqual(await group.locator('.metric-value').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color)),
            ['rgb(255, 165, 0)', 'rgb(255, 0, 0)'], 'Formatting must not change the original KiB/s values used by color rules')
        assert(Math.abs((await group.boundingBox()).height - staticHeight) < 1, 'Network hover details must not increase static row height')
        const networkEdges = await group.locator('.network-amount').evaluateAll(nodes => nodes.map(node => {
            const range = document.createRange(); range.selectNodeContents(node)
            return range.getBoundingClientRect().right
        }))
        assert.equal(networkEdges.length, 2)
        assert(Math.abs(networkEdges[0] - networkEdges[1]) < 1, 'Cumulative network numbers must share a right-aligned numeric column')
        assert(!(await group.innerText()).includes('since interface reset'))
        if (process.env.NETWORK_SCREENSHOT) await page.screenshot({ path: process.env.NETWORK_SCREENSHOT })
        await mutate(() => { window.harness.previewChinese = false; window.harness.config.store.language = 'en-US' })
        assert.deepEqual((await networkDetails.allTextContents()).map(value => value.trim()), ['Received total 201.900 GiB', 'Sent total 35.600 GiB'])
        assert.equal(await networkDetails.first().getAttribute('title'), 'Since interface creation or counter reset · eth0')
        await page.mouse.move(1040, 650)
        await mutate(() => {
            const h = window.harness, snapshot = h.networkPreviewSnapshot
            h.metrics = snapshot.metrics; h.group = snapshot.group; h.stats = snapshot.stats; h.detailResults = snapshot.detailResults
            h.previewChinese = snapshot.previewChinese; h.config.store.language = snapshot.language
            delete h.networkPreviewSnapshot
        })
        console.log('PASS network hover localizes received/sent totals and counter scope while retaining independent live rates')
        await mutate(() => { window.harness.showSettings = true })
        await page.locator('server-stats-settings').waitFor()
        assert.equal(errors.length, 0, errors.join('\n'))
        console.log('PASS real Angular templates instantiate without runtime errors')
        assert.equal(await page.locator('.new-item-editor').count(), 0)
        await page.locator('.add-single-btn').click()
        await page.locator('.new-item-editor').waitFor()
        assert.equal(await page.locator('.metric-fields select').first().inputValue(), 'text')
        await page.locator('.icon-picker-toggle').click()
        await page.locator('.icon-search').fill('显存')
        await page.locator('.icon-category').selectOption('Compute')
        await page.locator('.icon-picker-item').filter({ hasText: 'GPU memory' }).first().waitFor()
        assert.equal(await page.locator('.icon-picker-item .icon-preset-label').count(), 1)
        await page.locator('.icon-picker-item').first().click()
        assert((await page.locator('.icon-input-wrap input[type="text"]').inputValue()).startsWith('stats-'))
        assert.equal(await page.locator('.icon-input-wrap .input-group svg').count(), 1)
        await page.locator('.icon-picker-toggle').click()
        await page.locator('.icon-search').fill('不存在的图标')
        await page.waitForFunction(() => document.querySelectorAll('.icon-picker-item').length === 0)
        await page.locator('.icon-search').fill('')
        await page.locator('.icon-category').selectOption('all')
        if (process.env.ICONS_SCREENSHOT) {
            await mutate(() => { window.harness.previewChinese = true })
            await page.locator('.icon-picker-panel').screenshot({ path: process.env.ICONS_SCREENSHOT })
            await mutate(() => { window.harness.previewChinese = false })
        }
        await page.locator('.icon-picker-toggle').click()
        console.log('PASS meaningful SVG icons support Chinese search, category filtering and labeled selection')
        await page.locator('.check-command textarea').fill('printf yes')
        assert.equal(await page.locator('.metric-fields select:has(option[value="output"])').inputValue(), 'output')
        const commandPositions = await page.locator('.check-command, .metric-command, .detail-command').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top))
        assert(commandPositions[0] < commandPositions[1] && commandPositions[1] < commandPositions[2])
        console.log('PASS new labels default to text/output matching, with check-value-detail command order')
        const scopeMode = page.locator('#stats-scope-mode')
        assert.equal(await scopeMode.inputValue(), 'all')
        await scopeMode.selectOption('selected')
        await page.locator('.scope-option[title="p1"] input').check()
        await page.locator('.scope-option[title="p2"] input').check()
        assert.equal(await page.locator('.scope-selection').count(), 2)
        await page.locator('#stats-scope-search').fill('混合')
        assert.equal(await page.locator('.scope-option').count(), 1)
        assert((await page.locator('.scope-option').innerText()).includes('Saved Layout'))
        await mutate(() => { const c = window.harness.config; c.store.profiles = c.store.profiles.filter(p => p.id !== 'p1'); c.changed$.next() })
        assert((await page.locator('.scope-missing').innerText()).includes('P1'))
        await page.locator('.scope-missing button').click()
        await page.locator('.scope-selection button').click()
        assert.equal(await scopeMode.inputValue(), 'selected')
        assert((await page.locator('.scope-editor').innerText()).includes('No targets selected'))
        console.log('PASS scope multiselect, search and deleted-target removal preserve explicit empty scope')
        await page.locator('.editor-actions').getByRole('button', { name: 'Cancel', exact: true }).click()
        await page.waitForFunction(() => !document.querySelector('.new-item-editor'))
        console.log('PASS single-label form only appears after Add Single Label and closes on Cancel')
        await page.getByRole('button', { name: 'Add Group', exact: true }).click()
        await scopeMode.selectOption('selected')
        await page.locator('#stats-scope-search').fill('')
        await page.locator('.scope-option[title="layout"] input').check()
        assert((await page.locator('.scope-editor').innerText()).includes('The entire group shares this scope'))
        assert.equal(await page.locator('.scope-selection').count(), 1)
        console.log('PASS group editor assigns a shared saved-layout scope')
        await page.locator('.group-member-main .metric-fields input[type="text"]').first().fill('磁盘总余量')
        await page.locator('.group-member-main .metric-command textarea').fill('printf 542')
        await page.locator('.add-child-btn').click()
        await page.locator('.group-member-child .metric-fields input[type="text"]').first().fill('系统盘')
        await page.locator('.group-member-child .metric-command textarea').fill('printf 38')
        await page.locator('.group-member-child .detail-command textarea').fill('printf "38GB / 100GB"')
        await page.locator('.add-child-btn').click()
        await page.locator('.group-member-child .metric-fields input[type="text"]').first().fill('/data')
        await page.locator('.group-member-child .metric-command textarea').fill('printf 90')
        const mainMember = await page.locator('.group-member-main').boundingBox()
        const childMember = await page.locator('.group-member-child').first().boundingBox()
        assert(childMember.x >= mainMember.x + 16 && childMember.width < mainMember.width)
        await page.locator('.group-member-child .member-toggle').first().click()
        assert.equal(await page.locator('.member-editor').count(), 1)
        assert.equal(await page.locator('.group-member-child').first().locator('.member-editor').count(), 1)
        await page.locator('.group-member-child .metric-command textarea').fill('printf 39')
        await page.locator('.group-member-child .member-toggle').first().click()
        assert.equal(await page.locator('.member-editor').count(), 0)
        await page.locator('.group-member-main .member-toggle').click()
        await page.locator('.group-member-child .member-toggle').first().click()
        assert.equal(await page.locator('.group-member-child .metric-command textarea').inputValue(), 'printf 39')
        await page.getByRole('button', { name: 'Save Group', exact: true }).click()
        await page.locator('.group-card-preview').waitFor()
        assert.equal(await page.locator('.group-card-preview').count(), 1)
        assert.equal(await page.locator('.group-card-toggle').count(), 0)
        assert.equal(await page.locator('.new-item-editor').count(), 0)
        await page.locator('.group-card-heading').click()
        assert.equal(await page.locator('.group-card .inline-item-editor').count(), 0)
        await page.locator('.group-edit').click()
        assert.equal(await page.locator('.group-card .inline-item-editor').count(), 1)
        assert.equal(await page.locator('.new-item-editor').count(), 0)
        await page.locator('.group-member-child .member-toggle').first().click()
        assert.equal(await page.locator('.group-member-child .metric-command textarea').inputValue(), 'printf 39')
        console.log('PASS group Edit button opens inline editor; title does not toggle; child accordions retain drafts')
        for (const selector of ['.settings-section.single-labels-section', '.settings-section.metric-groups-section', '.preset-library', '.builtin-metrics']) {
            assert.equal(await page.locator(selector).count(), 1, `One visible section for ${selector}`)
            await assertVisibleBorders(page.locator(selector), selector)
        }
        await assertVisibleBorders(page.locator('.custom-metric-item, .group-member'), 'metric cards and group members')
        console.log('PASS large settings sections, label cards and group members have clearly visible 2px borders')
        const fieldStyles = await page.locator('.group-member-child .metric-command textarea').evaluate(n => {
            const style = getComputedStyle(n)
            return { background: style.backgroundColor, border: style.borderTopColor, borderWidth: style.borderTopWidth }
        })
        assert.notEqual(fieldStyles.background, 'rgba(0, 0, 0, 0)')
        assert.notEqual(fieldStyles.background, fieldStyles.border)
        assert.equal(fieldStyles.borderWidth, '1px')
        assert.equal(await page.locator('.group-member-child .metric-command .form-text').evaluate(n => getComputedStyle(n).opacity), '1')
        console.log('PASS controls have distinct backgrounds/borders and host theme cannot dim command help')
        if (process.env.SETTINGS_SCREENSHOT) {
            await mutate(() => { window.harness.previewChinese = true })
            await page.locator('.group-card').screenshot({ path: process.env.SETTINGS_SCREENSHOT })
            await mutate(() => { window.harness.previewChinese = false })
        }
        const childEditor = page.locator('.group-member-child').first()
        await childEditor.locator('.visible-unavailable').uncheck()
        assert.equal(await childEditor.locator('.carousel-unavailable').isChecked(), false)
        assert.equal(await childEditor.locator('.carousel-unavailable').isDisabled(), true)
        if (process.env.VISIBILITY_SCREENSHOT) {
            await mutate(() => { window.harness.previewChinese = true })
            await childEditor.screenshot({ path: process.env.VISIBILITY_SCREENSHOT })
            await mutate(() => { window.harness.previewChinese = false })
        }
        await childEditor.locator('.visible-unavailable').check()
        assert.equal(await childEditor.locator('.carousel-unavailable').isDisabled(), false)
        assert.equal(await childEditor.locator('.carousel-unavailable').isChecked(), false)
        await childEditor.getByRole('button', { name: 'Add Rule', exact: true }).click()
        await childEditor.locator('select:has(option[value="contains"])').selectOption('<')
        await childEditor.getByPlaceholder('Threshold / Value', { exact: true }).fill('20')
        await childEditor.locator('.member-enabled').click()
        assert.equal(await childEditor.locator('.member-enabled').getAttribute('aria-pressed'), 'false')
        assert.equal(await childEditor.evaluate(node => getComputedStyle(node).borderTopStyle), 'dashed')
        await assertVisibleBorders(childEditor, 'disabled child member')
        await childEditor.locator('.member-enabled').click()
        assert.equal(await childEditor.getByPlaceholder('Threshold / Value', { exact: true }).inputValue(), '20')
        await page.getByRole('button', { name: 'Save Group', exact: true }).click()
        const savedChild = await page.evaluate(() => window.harness.config.store.plugin.serverStats.metricGroups[0].children[0])
        assert.equal(savedChild.visibleWhenUnavailable, true)
        assert.equal(savedChild.showWhenUnavailable, false)
        assert.equal(savedChild.enabled, true)
        assert.equal(savedChild.colorRules[0].value, '20')
        assert.equal(savedChild.colorRules[0].operator, '<')
        console.log('PASS hiding a failed child disables carousel inclusion, and member toggles preserve color rules')
        await page.locator('.group-card .group-enabled').click()
        assert.equal(await page.locator('.group-card .group-enabled').getAttribute('aria-pressed'), 'false')
        assert.equal(await page.locator('.group-card').evaluate(node => getComputedStyle(node).borderTopStyle), 'dashed')
        await assertVisibleBorders(page.locator('.group-card'), 'disabled group card')
        await page.locator('.group-card .group-enabled').click()
        assert.deepEqual(await page.evaluate(() => window.harness.config.store.plugin.serverStats.metricGroups[0].children[0].colorRules), savedChild.colorRules)
        await mutate(() => {
            const conf = window.harness.config.store.plugin.serverStats
            conf.customMetrics = [{ id: 'ui-single', label: 'Toggle test', type: 'text', command: 'printf 99', colorRules: [{ operator: '>=', value: '90', color: '#ff0000' }] }]
        })
        await page.locator('.metric-enabled').click()
        await page.waitForFunction(() => document.querySelector('.metric-enabled')?.getAttribute('aria-pressed') === 'false')
        assert.equal(await page.locator('.metric-enabled').getAttribute('aria-pressed'), 'false')
        const disabledSingleCard = page.locator('.custom-metric-item').filter({ has: page.locator('.metric-enabled') })
        assert.equal(await disabledSingleCard.evaluate(node => getComputedStyle(node).borderTopStyle), 'dashed')
        await assertVisibleBorders(disabledSingleCard, 'disabled single-label card')
        await page.locator('.metric-enabled').click()
        const toggledSingle = await page.evaluate(() => window.harness.config.store.plugin.serverStats.customMetrics[0])
        assert.equal(toggledSingle.enabled, true)
        assert.equal(toggledSingle.command, 'printf 99')
        assert.deepEqual(toggledSingle.colorRules, [{ operator: '>=', value: '90', color: '#ff0000' }])
        console.log('PASS standalone/group enable switches preserve commands, children and color rules')
        const cpuBuiltin = page.locator('.builtin-card[data-builtin="cpu"]')
        await cpuBuiltin.locator('.builtin-enabled').click()
        await page.waitForFunction(() => document.querySelector('.builtin-card[data-builtin="cpu"] .builtin-enabled')?.getAttribute('aria-pressed') === 'false')
        assert.equal(await cpuBuiltin.locator('.builtin-enabled').getAttribute('aria-pressed'), 'false')
        await cpuBuiltin.locator('.builtin-edit').click()
        if (process.env.BUILTIN_SCREENSHOT) {
            await mutate(() => { window.harness.previewChinese = true })
            await cpuBuiltin.screenshot({ path: process.env.BUILTIN_SCREENSHOT })
            await mutate(() => { window.harness.previewChinese = false })
        }
        await cpuBuiltin.locator('.metric-command textarea').fill('printf 17')
        await cpuBuiltin.getByRole('button', { name: 'Save', exact: true }).click()
        assert.equal(await page.evaluate(() => window.harness.config.store.plugin.serverStats.defaultMetricOverrides.cpu.command), 'printf 17')
        await page.waitForFunction(() => document.querySelector('.builtin-card[data-builtin="cpu"] .builtin-reset')?.disabled === false)
        assert.equal(await cpuBuiltin.locator('.builtin-reset').isEnabled(), true)
        await cpuBuiltin.locator('.builtin-reset').click()
        assert.equal(await page.evaluate(() => window.harness.config.store.plugin.serverStats.defaultMetricOverrides.cpu), undefined)
        assert.equal(await page.evaluate(() => window.harness.config.store.plugin.serverStats.defaultMetrics.cpu), false)
        await page.waitForFunction(() => document.querySelector('.builtin-card[data-builtin="cpu"] .builtin-reset')?.disabled === true)
        assert.equal(await cpuBuiltin.locator('.builtin-reset').isDisabled(), true)
        assert.equal(await page.evaluate(() => window.harness.config.store.plugin.serverStats.customMetrics[0].command), 'printf 99')
        console.log('PASS built-in CPU saves an override and restores only that item without re-enabling it')
        const netBuiltin = page.locator('.builtin-card[data-builtin="net"]')
        await netBuiltin.locator('.builtin-edit').click()
        await netBuiltin.locator('.inline-item-editor').waitFor()
        assert.equal(await netBuiltin.locator('.group-member-child').count(), 2)
        assert.equal(await netBuiltin.locator('.group-member-main .member-enabled').getAttribute('aria-pressed'), 'false')
        await netBuiltin.locator('.group-member-child .member-toggle').first().click()
        await netBuiltin.locator('.group-member-child .metric-command textarea').fill('printf 8.5')
        await netBuiltin.getByRole('button', { name: 'Save Group', exact: true }).click()
        const savedNetwork = await page.evaluate(() => window.harness.config.store.plugin.serverStats.defaultMetricOverrides.net)
        assert.equal(savedNetwork.children[0].command, 'printf 8.5')
        assert.equal(savedNetwork.children[0].suffix, ' KiB/s')
        assert.equal(savedNetwork.main.enabled, false)
        await netBuiltin.locator('.builtin-reset').click()
        console.log('PASS built-in network uses the same group editor and preserves its two-direction layout')
        const builtinOrder = async () => page.locator('.builtin-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-builtin')))
        assert.deepEqual(await builtinOrder(), ['cpu', 'ram', 'disk', 'net'])
        assert.equal(await page.locator('.builtin-card').first().locator('.builtin-move-up').isDisabled(), true)
        assert.equal(await page.locator('.builtin-card').last().locator('.builtin-move-down').isDisabled(), true)
        await netBuiltin.locator('.builtin-move-up').click()
        assert.deepEqual(await page.evaluate(() => window.harness.config.store.plugin.serverStats.builtinOrder), ['cpu', 'ram', 'net', 'disk'])
        await page.waitForFunction(expected => [...document.querySelectorAll('.builtin-card')].map(card => card.getAttribute('data-builtin')).join(',') === expected,
            'cpu,ram,net,disk')
        assert.deepEqual(await builtinOrder(), ['cpu', 'ram', 'net', 'disk'])
        await cpuBuiltin.locator('.builtin-move-down').click()
        const reorderedBuiltins = ['ram', 'cpu', 'net', 'disk']
        assert.deepEqual(await page.evaluate(() => window.harness.config.store.plugin.serverStats.builtinOrder), reorderedBuiltins)
        await page.waitForFunction(expected => [...document.querySelectorAll('.builtin-card')].map(card => card.getAttribute('data-builtin')).join(',') === expected,
            reorderedBuiltins.join(','))
        assert.deepEqual(await builtinOrder(), reorderedBuiltins)
        await mutate(() => {
            const h = window.harness
            h.builtinReloadSnapshot = JSON.stringify(h.config.store)
            h.showSettings = false
        })
        assert.equal(await page.locator('server-stats-settings').count(), 0)
        await mutate(() => {
            const h = window.harness
            h.config.store = JSON.parse(h.builtinReloadSnapshot)
            h.showSettings = true
            delete h.builtinReloadSnapshot
        })
        await page.locator('server-stats-settings').waitFor()
        assert.deepEqual(await builtinOrder(), reorderedBuiltins, 'Serialized order survives a fresh settings component')
        assert.equal(await cpuBuiltin.locator('.builtin-enabled').getAttribute('aria-pressed'), 'false', 'Reordering must not enable disabled built-ins')
        assert.equal(await page.locator('.builtin-card').first().locator('.builtin-move-up').isDisabled(), true)
        assert.equal(await page.locator('.builtin-card').last().locator('.builtin-move-down').isDisabled(), true)
        console.log('PASS built-in move buttons update saved order and a recreated settings component restores it')
        await page.locator('.preset-search').fill('GPU')
        const gpuPreset = page.locator('.preset-card').filter({ hasText: 'GPU memory' }).filter({ hasText: 'Metric Group' })
        await gpuPreset.waitFor()
        assert.equal(await gpuPreset.count(), 1)
        if (process.env.PRESETS_SCREENSHOT) {
            await mutate(() => { window.harness.config.store.language = 'zh-CN'; window.harness.previewChinese = true })
            await page.locator('.preset-library').screenshot({ path: process.env.PRESETS_SCREENSHOT })
            await mutate(() => { window.harness.config.store.language = 'en'; window.harness.previewChinese = false })
        }
        await gpuPreset.locator('.preset-add').click()
        const importedGpu = await page.evaluate(() => window.harness.config.store.plugin.serverStats.metricGroups.at(-1))
        assert.equal(importedGpu.main.type, 'text')
        assert.equal(importedGpu.main.suffix, '%')
        assert.equal(importedGpu.children.length, 8)
        assert.equal(importedGpu.displayScope.mode, 'all')
        assert(importedGpu.children.every(m => m.visibleWhenUnavailable === false && m.showWhenUnavailable === false))
        assert(importedGpu.main.command.includes('memory.used,memory.total,memory.free'))
        assert.equal(importedGpu.presetMetadata.source.license, 'MIT')
        await page.locator('.preset-search').fill('P3')
        const labPreset = page.locator('.preset-card').filter({ hasText: 'P3' })
        assert.equal((await labPreset.locator('.preset-lab-badge').innerText()).trim(), "Author's lab only")
        assert((await labPreset.locator('.preset-description').innerText()).includes('please do not download or use'))
        await mutate(() => { window.harness.config.store.language = 'zh-CN'; window.harness.previewChinese = true })
        assert.equal((await labPreset.locator('.preset-lab-badge').innerText()).trim(), '作者实验室自用')
        assert((await labPreset.locator('.preset-description').innerText()).startsWith('作者实验室自用，其他人请勿下载使用。'))
        if (process.env.LAB_PRESETS_SCREENSHOT) await labPreset.screenshot({ path: process.env.LAB_PRESETS_SCREENSHOT })
        await mutate(() => { window.harness.config.store.language = 'en'; window.harness.previewChinese = false })
        await page.locator('.preset-card').filter({ hasText: 'P3' }).locator('.preset-add').click()
        const importedDisk = await page.evaluate(() => window.harness.config.store.plugin.serverStats.metricGroups.at(-1))
        assert.equal(importedDisk.displayScope.mode, 'selected')
        assert.deepEqual(importedDisk.displayScope.profileIds, [])
        assert.equal(importedDisk.children.length, 3)
        assert.equal(importedDisk.children[0].label, '系统盘')
        assert((await page.locator('.preset-message').innerText()).includes('P3(ai)'))
        assert.equal(externalRequests.length, 0, externalRequests.join('\n'))
        console.log('PASS offline presets add all eight GPU labels and keep unmatched disk bindings explicitly restricted')
        // Keep the zero-network assertion above: GitHub is accessed only after an
        // explicit click. All HTTPS traffic below is intercepted, never sent out.
        await page.locator('.preset-search').fill('')
        // fill() dispatches the input event before Angular necessarily renders
        // the full list. Capture the baseline only after filtering has finished.
        const bundledPresetCount = JSON.parse(fs.readFileSync(path.join(__dirname, '../presets.json'), 'utf8')).length
        await page.waitForFunction(expected => document.querySelector('.preset-search')?.value === '' &&
            document.querySelectorAll('.preset-card').length === expected, bundledPresetCount)
        if (process.env.SECTIONS_SCREENSHOT) {
            await mutate(() => {
                const h = window.harness, conf = h.config.store.plugin.serverStats
                h.sectionPreview = { language: h.config.store.language, chinese: h.previewChinese,
                    single: conf.customMetrics[0].label, group: conf.metricGroups[0].label }
                h.config.store.language = 'zh-CN'; h.previewChinese = true
                conf.customMetrics[0].label = '系统盘示例'; conf.metricGroups[0].label = '磁盘标签组示例'
            })
            try {
                await page.locator('server-stats-settings').screenshot({ path: process.env.SECTIONS_SCREENSHOT })
            } finally {
                await mutate(() => {
                    const h = window.harness, conf = h.config.store.plugin.serverStats, saved = h.sectionPreview
                    h.config.store.language = saved.language; h.previewChinese = saved.chinese
                    conf.customMetrics[0].label = saved.single; conf.metricGroups[0].label = saved.group
                    delete h.sectionPreview
                })
            }
        }
        const initialPresetTitles = await page.locator('.preset-card strong').allTextContents()
        const unchangedSettings = await page.evaluate(() => JSON.stringify(window.harness.config.store.plugin.serverStats))
        await mutate(() => {
            const h = window.harness, config = h.config
            h.githubSaveCalls = 0; h.githubOriginalSave = config.save
            config.save = function (...args) { h.githubSaveCalls++; return h.githubOriginalSave.apply(this, args) }
        })
        const remoteRequests = []
        let releaseRemoteResponse
        let remoteResponse = { status: 200, body: JSON.stringify([{ label: 'GitHub legacy example', command: 'printf 7', type: 'text', icon: 'stats-system-disk' }]),
            gate: new Promise(resolve => { releaseRemoteResponse = resolve }) }
        const githubRoute = async route => {
            remoteRequests.push(route.request().url())
            if (route.request().url() !== githubPresetUrl) { await route.abort('blockedbyclient'); return }
            const response = remoteResponse
            if (response.gate) await response.gate
            await route.fulfill({ status: response.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: response.body })
        }
        await page.route('https://**/*', githubRoute)
        const githubButton = page.locator('.preset-github')
        const noPresetSave = async () => {
            assert.equal(await page.evaluate(() => window.harness.githubSaveCalls), 0, 'Loading a remote library must not call config.save')
            assert.equal(await page.evaluate(() => JSON.stringify(window.harness.config.store.plugin.serverStats)), unchangedSettings,
                'Loading a remote library must not activate or alter configured metrics')
        }
        const waitGithubIdle = async () => page.waitForFunction(() => document.querySelector('.preset-github')?.disabled === false)
        try {
            const firstRequest = page.waitForRequest(request => request.url().startsWith('https://'))
            await githubButton.click()
            assert.equal((await firstRequest).url(), githubPresetUrl)
            await page.waitForFunction(() => document.querySelector('.preset-github')?.disabled === true)
            assert.equal(await githubButton.isDisabled(), true)
            assert.deepEqual(await page.locator('.preset-card strong').allTextContents(), initialPresetTitles, 'The existing library remains visible while loading')
            await githubButton.evaluate(button => { button.click(); button.click() })
            assert.equal(remoteRequests.length, 1, 'Repeated clicks while loading must not create duplicate requests')
            releaseRemoteResponse()
            await page.locator('.preset-card').filter({ hasText: 'GitHub legacy example' }).waitFor()
            await waitGithubIdle()
            const legacyTitles = await page.locator('.preset-card strong').allTextContents()
            assert(initialPresetTitles.every(title => legacyTitles.includes(title)), 'Bundled presets remain after loading a legacy array')
            assert.equal(legacyTitles.length, initialPresetTitles.length + 1)
            await noPresetSave()
            console.log('PASS explicit GitHub import uses the fork URL, loads legacy arrays once, and disables duplicate clicks without saving')

            const remoteGroup = { id: 'github-browser-group', kind: 'group', label: 'GitHub 磁盘示例',
                labels: { en: 'GitHub disk example', zh: 'GitHub 磁盘示例' },
                descriptions: { en: 'A sample group loaded from GitHub. Review before adding.', zh: '从 GitHub 加载的示例标签组，确认后再添加。' },
                source: { name: 'Tabby Group Server Stats', license: 'MIT' },
                group: { id: 'github-browser-group-definition', label: 'GitHub 磁盘示例', mode: 'overview', layout: 'vertical',
                    main: { id: 'github-main', label: '系统盘', command: 'printf 25', type: 'text', suffix: 'GiB' },
                    children: [{ id: 'github-child', label: '/data', command: 'printf 80', type: 'text', detailCommand: 'printf "80 / 100 GiB"' }] } }
            remoteResponse = { status: 200, body: JSON.stringify([remoteGroup]) }
            await githubButton.click()
            await page.locator('.preset-card').filter({ hasText: 'GitHub disk example' }).waitFor()
            await waitGithubIdle()
            assert.equal(remoteRequests.length, 2, 'A single click loads the new group format')
            const groupTitles = await page.locator('.preset-card strong').allTextContents()
            assert(legacyTitles.every(title => groupTitles.includes(title)), 'Previously loaded and bundled presets remain after loading a group library')
            assert.equal(groupTitles.length, initialPresetTitles.length + 2)
            assert.equal(await page.locator('.preset-message.preset-error').count(), 0)
            await noPresetSave()
            if (process.env.GITHUB_PRESETS_SCREENSHOT) {
                await mutate(() => { window.harness.config.store.language = 'zh-CN'; window.harness.previewChinese = true })
                try {
                    await page.locator('.preset-library').screenshot({ path: process.env.GITHUB_PRESETS_SCREENSHOT })
                } finally {
                    await mutate(() => { window.harness.config.store.language = 'en'; window.harness.previewChinese = false })
                }
            }
            const libraryBeforeFailure = await page.locator('.preset-card').allTextContents()
            mockedGithubHttpFailure = true
            remoteResponse = { status: 503, body: JSON.stringify({ message: 'Mock service unavailable' }) }
            await githubButton.click()
            await page.locator('.preset-message.preset-error').waitFor({ state: 'visible' })
            await waitGithubIdle()
            assert((await page.locator('.preset-message.preset-error').innerText()).trim().length > 8, 'GitHub failure must have a visible explanation')
            assert.deepEqual(await page.locator('.preset-card').allTextContents(), libraryBeforeFailure, 'A failed download preserves the complete current library')
            await noPresetSave()
            remoteResponse = { status: 200, body: JSON.stringify([remoteGroup]) }
            await githubButton.click()
            await page.waitForFunction(() => !document.querySelector('.preset-message.preset-error') && document.querySelector('.preset-github')?.disabled === false)
            assert.deepEqual(remoteRequests, Array(4).fill(githubPresetUrl))
            assert.equal(await page.locator('.preset-card').filter({ hasText: 'GitHub disk example' }).count(), 1)
            await noPresetSave()
            console.log('PASS GitHub group JSON loads without enabling metrics, HTTP errors retain the library, and one retry clears the error')
        } finally {
            releaseRemoteResponse()
            // A failed assertion may leave the first route behind its gate.
            // Finish that handler before disabling interception or closing the
            // page, so a cleanup race cannot replace the original assertion.
            await page.unrouteAll({ behavior: 'wait' })
            await mutate(() => {
                const h = window.harness
                h.config.save = h.githubOriginalSave
                delete h.githubOriginalSave; delete h.githubSaveCalls
            })
        }
        await mutate(() => {
            const conf = window.harness.config.store.plugin.serverStats
            conf.customMetrics[0].displayScope = { mode: 'selected', profileIds: ['private-local-profile-id'], profileNames: { 'private-local-profile-id': 'Shared connection' } }
        })
        const downloadPromise = page.waitForEvent('download')
        await page.locator('.preset-export').click()
        const download = await downloadPromise
        const exported = fs.readFileSync(await download.path(), 'utf8')
        assert.doesNotMatch(exported, /private-local-profile-id/)
        const exportedLibrary = JSON.parse(exported)
        assert.deepEqual(exportedLibrary.find(p => p.kind === 'metric' && p.label === 'Toggle test').profileNames, ['Shared connection'])
        const exportedGpu = exportedLibrary.find(p => p.kind === 'group' && p.group.children.length === 8)
        assert.equal(exportedGpu.source.license, 'MIT')
        assert.equal(exportedGpu.labels.zh, 'GPU 显存')
        assert(exportedGpu.descriptions.en.includes('VRAM'))
        const groupsBeforeImport = await page.evaluate(() => window.harness.config.store.plugin.serverStats.metricGroups.length)
        await page.locator('.preset-library input[type="file"]').setInputFiles({ name: 'shared-presets.json', mimeType: 'application/json', buffer: Buffer.from(exported) })
        await page.waitForFunction(() => document.querySelector('.preset-message')?.textContent.includes('Library loaded'))
        assert.equal(await page.evaluate(() => window.harness.config.store.plugin.serverStats.metricGroups.length), groupsBeforeImport)
        console.log('PASS library export removes local binding IDs, retains bilingual/source metadata, and import only previews')
        await mutate(() => { window.harness.config.store.language = 'zh-CN'; window.harness.previewChinese = true })
        assert.equal(await page.locator('.add-single-btn').innerText(), '添加单标签')
        assert.equal((await page.locator('.preset-library-header h4').innerText()).trim(), '预设库')
        await page.locator('.preset-search').fill('GPU')
        assert((await page.locator('.preset-list').innerText()).includes('GPU 显存'))
        await page.locator('.add-single-btn').click()
        await page.locator('.icon-picker-toggle').click()
        await page.locator('.icon-search').fill('显存')
        await page.waitForFunction(() => document.querySelectorAll('.icon-picker-item').length === 1)
        assert((await page.locator('.icon-picker-item .icon-preset-label').innerText()).includes('GPU 显存'))
        await mutate(() => { window.harness.config.store.language = 'en-US'; window.harness.previewChinese = false })
        assert.equal(await page.locator('.add-single-btn').innerText(), 'Add Single Label')
        assert.equal((await page.locator('.preset-library-header h4').innerText()).trim(), 'Preset Library')
        assert.equal(await page.locator('.icon-picker-item .icon-preset-label').innerText(), 'GPU memory')
        assert((await page.locator('.preset-list').innerText()).includes('GPU memory'))
        await page.locator('.editor-actions').getByRole('button', { name: 'Cancel', exact: true }).click()
        console.log('PASS English/Chinese switching localizes new controls, preset metadata and Chinese icon aliases')
        await mutate(() => { window.harness.showSettings = false; window.harness.showScopeDemo = true })
        const panes = page.locator('.scope-pane')
        assert.equal(await panes.count(), 3)
        for (const i of [0, 2]) {
            assert((await panes.nth(i).innerText()).includes('P1 数据盘'))
            assert(!(await panes.nth(i).innerText()).includes('P2 GPU'))
        }
        assert((await panes.nth(1).innerText()).includes('P2 GPU'))
        assert(!(await panes.nth(1).innerText()).includes('P1 数据盘'))
        for (let i = 0; i < 3; i++) {
            assert((await panes.nth(i).innerText()).includes('公共指标'))
            assert((await panes.nth(i).innerText()).includes('布局公共状态'))
        }
        if (process.env.SCOPE_SCREENSHOT) await page.locator('.scope-demo').screenshot({ path: process.env.SCOPE_SCREENSHOT })
        console.log('PASS mixed P1/P2/P1 panes isolate connection metrics and inherit layout/global metrics')
        await mutate(() => { window.harness.scopeProfiles = window.harness.scopeProfiles.filter(p => p.id !== 'p1') })
        assert(!(await page.locator('.scope-demo').innerText()).includes('P1 数据盘'))
        assert((await panes.nth(1).innerText()).includes('P2 GPU'))
        console.log('PASS deletion of a selected profile never broadens its scope')
        assert.equal(errors.length, 0, errors.join('\n'))
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
