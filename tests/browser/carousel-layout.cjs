const assert = require('node:assert/strict')
module.exports = async function carouselLayout(page) {
    await page.setViewportSize({ width: 1100, height: 720 })
    await page.reload()
    await page.waitForFunction(() => window.ready)
    await page.evaluate(() => {
        const h = window.harness
        h.metrics = []
        const metric = (id, label, icon, suffix) => ({ id, label, icon, suffix, type: 'text', command: 'printf 1' })
        h.group = { id: 'carousel-size', mode: 'carousel', interval: 1, layout: 'vertical',
            main: metric('size-main', '总读写', 'stats-database', 'MB/s'),
            children: [metric('size-disk', 'lsn_datasets', 'stats-database', 'MB/s'), metric('size-gpu', 'GPU 1', 'stats-gpu', '%')] }
        h.stats = { custom: [{ id: 'size-main', value: '0.00', status: 'ok' }, { id: 'size-disk', value: '0.00', status: 'ok' }, { id: 'size-gpu', value: '72', status: 'ok' }] }
        window.tick()
    })
    const active = page.locator('.bar .carousel-active')
    const group = page.locator('.bar .metric-group')
    const oneLine = async () => {
        const a = await active.locator('.metric-label').boundingBox(), b = await active.locator('.metric-reading').boundingBox()
        assert(Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < 2, `Label and reading must stay on one line: ${JSON.stringify({ a, b })}`)
    }
    await oneLine()
    for (const mode of ['overview', 'carousel']) {
        await page.evaluate(mode => { window.harness.group = { ...window.harness.group, mode }; window.tick() }, mode)
        const slot = await group.locator('.collapsed-slot').boundingBox()
        const row = await group.locator('.collapsed-row').boundingBox()
        assert(Math.abs(slot.height - row.height) < 1, `${mode}: inline baseline must not add empty space below the row`)
        assert(Math.abs((await group.boundingBox()).y - row.y) < 1, `${mode}: top alignment stays at the group top`)
        await page.locator('.bar server-stats-metric-strip').evaluate(node => { node.classList.add('center-aligned'); node.style.height = '60px' })
        const outer = await group.boundingBox(), centered = await group.locator('.collapsed-row').boundingBox()
        assert(Math.abs(outer.y + outer.height / 2 - centered.y - centered.height / 2) < 1, `${mode}: center the actual visible row`)
        await page.locator('.bar server-stats-metric-strip').evaluate(node => { node.classList.remove('center-aligned'); node.style.height = '' })
    }
    const width = (await group.boundingBox()).width
    await page.waitForFunction(() => document.querySelector('.carousel-active').textContent.includes('GPU 1'))
    await oneLine()
    assert(Math.abs((await group.boundingBox()).width - width) < 1, 'Rotating keeps group width stable')
    await page.waitForFunction(() => document.querySelector('.carousel-active').textContent.includes('lsn_datasets'))
    await oneLine()
    if (process.env.CAROUSEL_SCREENSHOT) await group.screenshot({ path: process.env.CAROUSEL_SCREENSHOT })
    // A user changing UI font size must invalidate the original measurement.
    await page.addStyleTag({ content: '.bar .metric-label { font: 700 22px Arial; letter-spacing: 1px; } .bar .metric-value { font: 600 20px monospace; }' })
    await page.evaluate(() => window.tick())
    await oneLine()
    assert((await group.boundingBox()).width > width, 'Typography changes remeasure the width')
    await page.setViewportSize({ width: 420, height: 720 })
    assert(await group.evaluate(node => node.getBoundingClientRect().right <= innerWidth), 'Narrow panes stay inside their viewport')
    console.log('PASS carousel bold labels and readings share a line, rotation stays stable, font changes remeasure and narrow panes stay bounded')
}
