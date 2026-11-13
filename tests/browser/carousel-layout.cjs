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
