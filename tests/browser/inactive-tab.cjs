const assert = require('node:assert/strict')

module.exports = async function inactiveTab(page) {
    await page.setViewportSize({ width: 1100, height: 720 })
    await page.reload()
    await page.waitForFunction(() => window.ready)
    // Actual Tabby appRoot CSS moves inactive tabs offscreen, leaving their
    // layout boxes intact. display:none alone misses this lifecycle case.
    await page.addStyleTag({ content: '.bar.content-tab{position:relative;left:0}.bar.content-tab:not(.content-tab-active){left:-1000%}' })
    await page.locator('.bar').evaluate(node => node.classList.add('content-tab', 'content-tab-active'))
    for (const mode of ['single', 'group']) {
        await page.evaluate(mode => {
            const h = window.harness
            const metric = id => ({ id, label: id, command: 'printf 1', detailCommand: 'printf details', type: 'text' })
            h.metrics = mode === 'single' ? [metric('inactive-single')] : []
            h.group = mode === 'single' ? { id: 'empty', children: [] } : {
                id: 'inactive-group', label: 'Inactive group', mode: 'overview', layout: 'vertical',
                main: metric('inactive-main'), children: [metric('inactive-child')],
            }
            h.stats = { custom: ['inactive-single', 'inactive-main', 'inactive-child'].map(id => ({ id, value: '1', status: 'ok' })) }
            h.hoverCalls = []; h.detailCalls = []
            window.tick()
        }, mode)
        await page.locator(mode === 'single' ? '.bar .single' : '.bar .metric-group').click()
        await page.waitForFunction(() => window.harness.detailCalls.length > 0)
        assert.equal(await page.locator('.group-details').count(), 1)
        await page.locator('.bar').evaluate(node => node.classList.remove('content-tab-active'))
        assert(await page.locator('.bar').evaluate(node => node.getClientRects().length > 0 && node.getBoundingClientRect().right < 0), 'Inactive Tabby fixture retains offscreen layout boxes')
        await page.waitForFunction(() => !document.querySelector('.group-details'), null, { timeout: 2000 })
        const stopped = await page.evaluate(() => ({ primary: window.harness.hoverCalls.length, details: window.harness.detailCalls.length }))
        await page.waitForTimeout(1300)
        assert.deepEqual(await page.evaluate(() => ({ primary: window.harness.hoverCalls.length, details: window.harness.detailCalls.length })), stopped, `${mode}: inactive tabs must not continue accelerated collection`)
        await page.mouse.move(1050, 10)
        await page.locator('.bar').evaluate(node => node.classList.add('content-tab-active'))
        await page.waitForTimeout(300)
        assert.equal(await page.locator('.group-details').count(), 0, `${mode}: returning to the tab must not reopen its old popup`)
    }

    await page.evaluate(() => {
        const h = window.harness
        h.metrics = [{ id: 'inactive-blocked', label: 'Blocked value', command: 'printf 1', detailCommand: 'printf details', type: 'text' }]
        h.group = { id: 'empty', children: [] }
        h.stats = { custom: [{ id: 'inactive-blocked', value: '1', status: 'ok' }] }
        h.hoverBlockedIds = ['inactive-blocked']; h.hoverResolvers = {}; h.detailCalls = []
        window.tick()
    })
    await page.locator('.bar .single').click()
    await page.waitForFunction(() => !!window.harness.hoverResolvers['inactive-blocked'])
    await page.locator('.bar').evaluate(node => node.classList.remove('content-tab-active'))
    await page.waitForFunction(() => !document.querySelector('.group-details'), null, { timeout: 2000 })
    await page.evaluate(() => {
        window.harness.hoverBlockedIds = []
        window.harness.hoverResolvers['inactive-blocked']()
    })
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => window.harness.detailCalls.length), 0, 'A primary response arriving in an inactive tab must not start detail commands')
    assert.equal(await page.locator('.group-details').count(), 0)
    console.log('PASS offscreen inactive Tabby tabs close standalone/group popups, stop acceleration, discard late detail follow-ups and stay collapsed on return')
}
