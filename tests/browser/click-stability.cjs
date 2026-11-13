const assert = require('node:assert/strict')
module.exports = async function clickStability(page) {
    await page.reload()
    await page.waitForFunction(() => window.ready)
    await page.addStyleTag({ content: 'visibility-pane{width:430px;height:200px!important} visibility-pane .single{min-width:220px}' })
    for (const mode of ['single', 'overview', 'carousel', 'vertical', 'horizontal']) {
        await page.evaluate(mode => {
            const h = window.harness
            h.showVisibilityDemo = false; window.tick()
            const m = id => ({ id, label: id, type: 'text', command: 'printf 1', detailCommand: 'printf details' })
            h.visibilityPanes = [h.visibilityPanes[0]]; h.focusFollowsMouse = true
            h.config.store.plugin.serverStats.customMetrics = [m('single')]
            h.config.store.plugin.serverStats.metricGroups = mode === 'single' ? [] : [{ id: 'stable', label: 'stable',
                mode: ['overview', 'carousel'].includes(mode) ? mode : 'static', layout: mode === 'horizontal' ? 'horizontal' : 'vertical',
                main: m('main'), children: [m('child')] }]
            h.stats = { custom: ['single', 'main', 'child'].map(id => ({ id, value: '1', status: 'ok' })) }
            h.detailResults = { single: 'Detail response', main: 'Detailed response with a wider value', child: 'Detail response' }
            h.showVisibilityDemo = true; window.tick()
        }, mode)
        const pane = page.locator('visibility-pane')
        const label = pane.locator(mode === 'single' ? '.single .metric-label' : '.metric-group .metric-label:visible').first()
        const before = await label.boundingBox()
        await label.click()
        await page.waitForTimeout(300)
        const expanded = mode === 'single' ? page.locator('.single-details') : ['overview', 'carousel'].includes(mode) ? page.locator('.group-details') : pane.locator('.metric-detail')
        assert(await expanded.count() > 0, `${mode}: clicking must stay open after layout and focus events`)
        if (mode === 'vertical') {
            const after = await label.boundingBox()
            assert(Math.abs(after.y - before.y) > 1 || Math.abs(after.x - before.x) > 1, `The bottom-bar fixture really reflows when inline details expand: ${JSON.stringify({ before, after })}`)
        }
        // Tabby can return keyboard focus to its terminal without moving the pointer.
        await pane.locator('.visibility-terminal').evaluate(node => node.focus())
        await page.waitForTimeout(150)
        assert(await expanded.count() > 0, `${mode}: terminal focus must not dismiss mouse-opened details`)
        if (['single', 'overview', 'carousel'].includes(mode)) {
            const a = await label.boundingBox(), p = await expanded.boundingBox()
            const x = Math.max(a.x, p.x) + 3
            const y = p.y < a.y ? (p.y + p.height + a.y) / 2 : (a.y + a.height + p.y) / 2
            await page.mouse.move(x, y)
            await page.waitForTimeout(300)
            assert(await expanded.count() > 0, `${mode}: the gap leading into details belongs to the same interaction region`)
        }
        await expanded.first().hover()
        await page.waitForTimeout(300)
        assert(await expanded.count() > 0, `${mode}: moving onto details must keep them open`)
        await label.click()
        assert.equal(await expanded.count(), 0, `${mode}: second click still closes`)
        await label.click()
        await page.mouse.move(1000, 20)
        await page.waitForTimeout(200)
        assert.equal(await expanded.count(), 0, `${mode}: moving out still closes`)
    }
    console.log('PASS click details survive terminal focus and bottom-bar reflow in all five layouts, with second-click and pointer-exit dismissal')
}
