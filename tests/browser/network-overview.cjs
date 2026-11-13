const assert = require('node:assert/strict')

module.exports = async function networkOverview(page) {
    await page.reload()
    await page.setViewportSize({ width: 1100, height: 720 })
    await page.waitForFunction(() => window.ready)
    await page.evaluate(() => { window.harness.showSettings = true; window.tick() })
    const editor = page.locator('.builtin-card[data-builtin="net"]')
    await editor.locator('.builtin-edit').click()
    await editor.locator('.inline-item-editor').waitFor()
    assert.equal(await editor.locator('.group-member-main .member-enabled').getAttribute('aria-pressed'), 'true',
        'The actual factory network main label must be enabled for overview mode')
    await editor.getByRole('button', { name: 'Save Group', exact: true }).click()

    await page.evaluate(() => {
        const h = window.harness, conf = h.config.store.plugin.serverStats
        // Use the definition produced by the real built-in editor, including its
        // IDs, units and defaults. Only transport readings are mocked here;
        // network.test.cjs exercises summation using actual shell fixtures.
        const network = conf.defaultMetricOverrides.net
        conf.customMetrics = []
        conf.metricGroups = [{ ...network, interval: 1 }]
        conf.enabled = true
        h.metrics = []; h.group = { id: 'empty', children: [] }
        h.stats = { custom: [
            { id: 'builtin-net-main', value: '4882.8125', status: 'ok' },
            { id: 'builtin-net-rx', value: '976.5625', status: 'ok' },
            { id: 'builtin-net-tx', value: '3906.25', status: 'ok' },
        ] }
        h.showSettings = false
        h.visibilityPanes = [{ id: 'network-pane', open: true, profile: { id: 'p1' } }]
        h.showVisibilityDemo = true
        window.tick()
    })
    const pane = page.locator('visibility-pane')
    const group = pane.locator('.metric-group')
    await page.waitForFunction(() => document.querySelector('visibility-pane .metric-value')?.textContent.trim() === '5.000 MB/s')
    const rows = group.locator(':scope > .metric-row')
    assert.deepEqual((await rows.locator('.metric-label').allTextContents()).map(text => text.trim()), ['Network', 'Download', 'Upload'])
    assert.deepEqual((await rows.locator('.metric-value').allTextContents()).map(text => text.trim()), ['5.000 MB/s', '1.000 MB/s', '4.000 MB/s'])
    const selectMode = async mode => {
        await pane.locator('[data-testid="pane-status-toggle"]').click()
        await pane.locator(`.pane-menu-${mode}`).click()
        await page.mouse.move(1050, 10)
    }
    await selectMode('overview')
    assert.equal(await group.locator('.empty').count(), 0, 'Network overview must not show No available items')
    assert.equal((await group.locator('.collapsed-row .metric-label').innerText()).trim(), 'Network')
    assert.equal((await group.locator('.collapsed-row .metric-value').innerText()).trim(), '5.000 MB/s')

    await selectMode('carousel')
    const carousel = group.locator('.carousel-active')
    for (const [label, value] of [['Download', '1.000 MB/s'], ['Upload', '4.000 MB/s']]) {
        await page.waitForFunction(label => document.querySelector('visibility-pane .carousel-active .metric-label')?.textContent.trim() === label, label)
        assert.equal((await carousel.locator('.metric-value').innerText()).trim(), value)
    }
    await selectMode('static')
    assert.equal(await rows.count(), 3, 'Returning from carousel must retain the total and both directions')
    if (process.env.NETWORK_OVERVIEW_SCREENSHOT) await pane.screenshot({ path: process.env.NETWORK_OVERVIEW_SCREENSHOT })
    console.log('PASS actual built-in network defaults show combined total in overview, total/download/upload in static and both directions in carousel')
}
