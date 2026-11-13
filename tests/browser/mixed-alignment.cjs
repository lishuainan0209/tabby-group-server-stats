const assert = require('node:assert/strict')

module.exports = async function mixedAlignment(page) {
    await page.setViewportSize({ width: 1400, height: 600 })
    await page.reload()
    await page.waitForFunction(() => window.ready)
    // Tabby's theme uses line-height:1.6. Test the real bottom bar at the
    // screenshot's mixed standalone/group content. TEST_DEVICE_SCALE also
    // exercises fractional device pixels without changing menu coordinates.
    await page.addStyleTag({ content: 'body{margin:0;line-height:1.6}test-app>h2,test-app>p,.terminal,.bar{display:none!important}.visibility-terminal{background:#000}' })
    await page.evaluate(() => {
        const h = window.harness, conf = h.config.store.plugin.serverStats
        h.previewChinese = true
        h.config.store.language = 'zh-CN'
        const metric = (id, label, value, suffix = '', icon = '') => {
            h.stats.custom.push({ id, value, status: 'ok' })
            return { id, label, type: 'text', command: 'printf 1', suffix, icon }
        }
        h.stats = { custom: [] }
        conf.customMetrics = [
            { ...metric('builtin-ram', '内存', '11.4', '%'), type: 'progress' },
            metric('users', '登录用户', '6'),
        ]
        conf.metricGroups = [
            ['builtin-net', '网络', '0.003', 'MB/s', ''],
            ['threads', '线程数', '5/2546', '', 'stats-cpu'],
            ['capacity', '磁盘余量', '6366', 'GB', 'stats-database'],
            ['io', '总读写', '5.99', 'MB/s', 'stats-database'],
            ['gpu', 'GPU余量', '98', '%', 'stats-gpu'],
        ].map(([id, label, value, suffix, icon]) => ({ id, mode: 'overview', layout: 'vertical', interval: 1,
            main: metric(id + '-main', label, value, suffix, icon),
            children: [metric(id + '-child', label, value, suffix, icon)] }))
        conf.enabled = true
        h.visibilityPanes = [{ id: 'alignment-pane', open: true, profile: { id: 'p1' } }]
        h.showVisibilityDemo = true
        window.tick()
    })
    const pane = page.locator('visibility-pane'), strip = pane.locator('server-stats-metric-strip')
    await pane.locator('.single .metric-value').first().waitFor()
    const inspect = () => strip.evaluate(node => [...node.querySelectorAll(':scope > .single, :scope > .metric-group')].map(entry => {
        const content = entry.querySelector('.collapsed-row') || entry
        const rect = (selector, scope = content) => { const r = scope.querySelector(selector).getBoundingClientRect(); return { top: r.top, center: r.top + r.height / 2, height: r.height } }
        const label = content.querySelector('.metric-label > span:last-child')
        const range = document.createRange(); range.selectNodeContents(label)
        const text = range.getBoundingClientRect()
        range.selectNodeContents(content.querySelector('.metric-value'))
        const numericText = range.getBoundingClientRect()
        return { label: label.textContent, value: rect('.metric-value'), labelBox: rect('.metric-label'), textTop: text.top,
            valueTextTop: numericText.top,
            arrow: entry.querySelector('.expand-hint') ? rect('.expand-hint', entry) : null,
            icon: content.querySelector('.metric-label svg') ? rect('.metric-label svg') : null,
            meter: content.querySelector('.meter') ? rect('.meter') : null }
    }))
    const select = async (attribute, value) => {
        await pane.locator('[data-testid="pane-status-toggle"]').click()
        await pane.locator(attribute === 'mode' ? `.pane-menu-${value}` : `[data-alignment="${value}"]`).click()
        await page.mouse.move(1390, 590)
    }
    for (const mode of ['overview', 'carousel']) {
        await select('mode', mode)
        for (const height of ['', '64px']) {
            await strip.evaluate((node, height) => { node.style.minHeight = height }, height)
            for (const alignment of ['top', 'center']) {
                await select('alignment', alignment)
                const rows = await inspect()
                if (process.env.MIXED_ALIGNMENT_SCREENSHOT && mode === 'overview' && alignment === 'top' && !height) {
                    await pane.locator('.stats-container').screenshot({ path: process.env.MIXED_ALIGNMENT_SCREENSHOT })
                    console.log('Mixed alignment coordinates:', JSON.stringify(rows))
                }
                assert.equal(rows.length, 7)
                const spread = values => Math.max(...values) - Math.min(...values)
                assert(spread(rows.map(row => row.value.top)) < .8,
                    `${mode}/${alignment}: standalone and grouped numeric text must share a line: ${JSON.stringify(rows)}`)
                assert(spread(rows.map(row => row.labelBox.center)) < .8, `${mode}/${alignment}: label centers must match`)
                assert(spread(rows.map(row => row.textTop)) < .8, `${mode}/${alignment}: visible label text must share a line`)
                assert(spread(rows.map(row => row.valueTextTop)) < .8, `${mode}/${alignment}: visible numeric glyphs must share a line`)
                const bounds = await strip.boundingBox()
                const expectedCenter = bounds.y + (alignment === 'center' ? bounds.height : rows[0].value.height) / 2
                assert(rows.every(row => Math.abs(row.value.center - expectedCenter) < .8), `${mode}/${alignment}: respect the requested alignment beside taller content`)
                for (const row of rows) {
                    for (const ornament of [row.icon, row.meter, row.arrow].filter(Boolean)) {
                        assert(Math.abs(ornament.center - row.value.center) < .8, `${row.label}: icon/meter and reading centers must match`)
                    }
                }
            }
        }
    }
    console.log('PASS mixed standalone and overview/carousel labels, numeric text, icons and meters align in top and center modes')
}
