const assert = require('node:assert/strict')

module.exports = async function overlayRegression(page, mutate) {
    await page.reload()
    await page.waitForFunction(() => window.ready)
    await page.setViewportSize({ width: 1280, height: 800 })
    // A blocked primary request reproduces a slow SSH command without racing
    // a timer: the user must see feedback before we allow any response.
    for (const mode of ['single', 'overview', 'carousel', 'vertical', 'horizontal']) {
        await page.mouse.move(1260, 780)
        await page.keyboard.press('Escape')
        await page.evaluate(mode => {
            const h = window.harness
            const metric = id => ({ id, label: id, command: 'printf 1', detailCommand: 'printf details', type: 'text' })
            const main = metric('placeholder-main'), child = metric('placeholder-child')
            h.metrics = mode === 'single' ? [main] : []
            h.group = mode === 'single' ? { id: 'empty', children: [] } : {
                id: 'placeholder-group', mode: ['overview', 'carousel'].includes(mode) ? mode : 'static',
                layout: mode === 'horizontal' ? 'horizontal' : 'vertical', interval: 30,
                main, children: [child, { ...metric('placeholder-hidden'), visibleWhenUnavailable: false }],
            }
            h.stats = { custom: [main, child].map(m => ({ id: m.id, value: '-', status: 'pending' })) }
            h.stats.custom.push({ id: 'placeholder-hidden', value: 'Not mounted', status: 'unavailable' })
            h.hoverBlockedIds = [main.id]; h.hoverResolvers = {}; h.detailCalls = []
            h.detailResults = { [main.id]: 'Ready details', [child.id]: 'Ready details' }
            window.tick()
        }, mode)
        const target = page.locator(mode === 'single' ? '.bar .single' : mode === 'horizontal' ? '.bar .metric-group > .metric-row' : '.bar .metric-group').first()
        await target.click()
        assert(await page.locator('.detail-pending').count() > 0, `${mode}: placeholder is visible before a primary response`)
        assert((await page.locator('.detail-pending').first().innerText()).includes('Collecting details'))
        assert.equal(await page.evaluate(() => window.harness.detailCalls.length), 0)
        assert(!(await page.locator('.bar').innerText()).includes('placeholder-hidden'), 'Failed optional entries remain hidden')
        await page.evaluate(() => {
            const h = window.harness
            h.hoverBlockedIds = []
            h.hoverResolvers['placeholder-main']()
        })
        await page.waitForFunction(() => [...document.querySelectorAll('.metric-detail')].some(node => node.textContent.includes('Ready details')))
        assert.equal(await page.locator('.detail-pending').count(), 0)
    }
    console.log('PASS slow primary collection immediately shows placeholders in standalone, overview, carousel and both static layouts')

    await page.keyboard.press('Escape')
    await mutate(() => {
        const h = window.harness
        h.metrics = [{ id: 'empty-detail', label: 'Empty detail', type: 'text', command: 'printf 1', detailCommand: 'true' }]
        h.group = { id: 'empty', children: [] }
        h.stats = { custom: [{ id: 'empty-detail', value: '1', status: 'ok' }] }
        h.detailResults = { 'empty-detail': '' }
    })
    await page.locator('.bar .single').click()
    await page.waitForFunction(() => document.querySelector('.single-details')?.textContent.includes('Detail returned no data'))
    assert.equal(await page.locator('.detail-pending').count(), 0, 'Empty output finishes the loading state')
    await page.keyboard.press('Escape')
    await mutate(() => {
        const h = window.harness
        h.metrics = [{ ...h.metrics[0], id: 'failed-detail' }]
        h.stats = { custom: [{ id: 'failed-detail', value: '1', status: 'ok' }] }
        h.detailThrows = true
    })
    await page.locator('.bar .single').click()
    await page.waitForFunction(() => document.querySelector('.single-details')?.textContent.includes('Unable to fetch details'))
    assert.equal(await page.locator('.detail-pending').count(), 0, 'A rejected request also finishes loading')
    await page.keyboard.press('Escape')
    await mutate(() => {
        const h = window.harness
        h.metrics = [{ ...h.metrics[0], id: 'cached-detail' }]
        h.stats = { custom: [{ id: 'cached-detail', value: '1', status: 'ok' }] }
        h.detailThrows = false; h.detailResults = { 'cached-detail': 'Previously collected details' }
    })
    await page.locator('.bar .single').click()
    await page.waitForFunction(() => document.querySelector('.single-details')?.textContent.includes('Previously collected details'))
    await mutate(() => { window.harness.detailThrows = true; window.harness.detailCalls = [] })
    await page.waitForFunction(() => window.harness.detailCalls.length > 0)
    await page.waitForTimeout(100)
    assert((await page.locator('.single-details').innerText()).includes('Previously collected details'), 'Background refresh errors retain the previous content')
    assert.equal(await page.locator('.detail-pending').count(), 0)
    await page.keyboard.press('Escape')
    await mutate(() => {
        const h = window.harness
        h.metrics = [{ ...h.metrics[0], id: 'late-detail' }]
        h.stats = { custom: [{ id: 'late-detail', value: '1', status: 'ok' }] }
        h.hoverBlockedIds = ['late-detail']; h.hoverResolvers = {}; h.detailCalls = []; h.detailThrows = false
    })
    await page.locator('.bar .single').click()
    assert.equal(await page.locator('.detail-pending').count(), 1)
    await page.keyboard.press('Escape')
    await page.mouse.move(1260, 780)
    await page.evaluate(() => {
        const h = window.harness
        h.hoverBlockedIds = []; h.hoverResolvers['late-detail']()
    })
    await page.waitForTimeout(150)
    assert.equal(await page.locator('.single-details').count(), 0)
    assert.equal(await page.evaluate(() => window.harness.detailCalls.length), 0)
    console.log('PASS empty/error responses end loading, refresh errors retain content, and late responses do not reopen dismissed placeholders')

    await mutate(() => {
        const h = window.harness
        h.hostedSettings = true; h.showSettings = true; h.previewChinese = true
        const metric = (id, label) => ({ id, label, icon: 'stats-database', color: '#00ff00', type: 'text', command: 'printf 1', suffix: 'GB' })
        h.config.store.plugin.serverStats.metricGroups = [{
            id: 'overlay-disks', label: 'P4磁盘', mode: 'static', layout: 'vertical',
            main: metric('overlay-main', '磁盘余量'),
            children: Array.from({ length: 15 }, (_, i) => metric('overlay-child-' + i, i === 2 ? 'lsn_datasets' : '/data' + (i + 1))),
        }]
    })
    await page.locator('.group-edit').click()
    const nav = page.locator('.editor-navigator')
    assert(await nav.evaluate(node => node.parentElement === document.body), 'The navigator escapes transformed/clipped settings parents')
    await nav.locator('.navigator-main').click()
    await nav.locator('.navigator-child').nth(2).click()
    for (const width of [3440, 1920, 1280, 800]) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForFunction(() => Math.abs(document.querySelector('.editor-navigator').getBoundingClientRect().right - innerWidth + 16) < 2)
        const bounds = await nav.boundingBox()
        assert(bounds.width >= 220 && bounds.width <= 300, `${width}: floating width remains bounded`)
        assert(Math.abs(bounds.x + bounds.width - width + 16) < 2, `${width}: default position tracks the right edge`)
        assert(bounds.height <= 720 && Math.abs(bounds.y + bounds.height / 2 - 450) < 2)
        const editor = await page.locator('server-stats-settings').boundingBox()
        assert(Math.abs(editor.width - Math.max(640, Math.min(1440, width - 282))) < 2, `${width}: editor width adapts between its minimum and maximum`)
        assert.equal(await page.locator('server-stats-settings').evaluate(node => getComputedStyle(node).paddingRight), '0px')
        if (width === 800) assert(await page.locator('.host-content').evaluate(node => node.scrollWidth > node.clientWidth), 'Below the editor minimum, the content scrolls horizontally instead of crushing fields')
        const heading = await page.locator('.group-member-child').nth(2).locator('.member-toggle strong').boundingBox()
        assert(heading.width > 70 && heading.height < 40, `${width}: member names do not wrap one character per line (${JSON.stringify(heading)})`)
        assert(await nav.locator('.navigator-members').evaluate(node => node.scrollHeight > node.clientHeight), 'Long navigation lists scroll internally')
        const save = await nav.locator('.navigator-save').boundingBox()
        assert(save.y >= bounds.y && save.y + save.height <= bounds.y + bounds.height, 'Save remains visible below the scrolling list')
    }
    if (process.env.OVERLAY_SCREENSHOT) await page.screenshot({ path: process.env.OVERLAY_SCREENSHOT })
    console.log('PASS real Tabby 600px provider constraint is widened; 800–3440px windows retain usable editor and bounded scrollable navigation')

    const dragTo = async (x, y) => {
        const box = await nav.locator('.navigator-drag').boundingBox()
        await page.mouse.move(box.x + 12, box.y + 12)
        await page.mouse.down()
        await page.mouse.move(x, y, { steps: 8 })
        await page.mouse.up()
    }
    await dragTo(45, 90)
    let dragged = await nav.boundingBox()
    assert(dragged.x < 50, 'Navigation can cover Tabby’s left menus')
    assert(await nav.evaluate(node => {
        const b = node.getBoundingClientRect()
        return node.contains(document.elementFromPoint(b.x + 25, b.y + 25))
    }), 'The portal stays above menu content')
    await page.locator('.host-content').evaluate(node => { node.scrollTop += 300 })
    assert(Math.abs((await nav.boundingBox()).y - dragged.y) < 1, 'Scrolling the editor does not move the floating navigator')
    await dragTo(350, 140)
    assert((await nav.boundingBox()).x > 250, 'Navigation can also cover the editing area')
    await page.setViewportSize({ width: 480, height: 540 })
    await page.waitForFunction(() => document.querySelector('.editor-navigator').getBoundingClientRect().right <= innerWidth - 8)
    dragged = await nav.boundingBox()
    assert(dragged.x >= 8 && dragged.x + dragged.width <= 472 && dragged.y >= 8 && dragged.y + dragged.height <= 532, 'Resizing clamps a dragged panel back into view')
    await nav.locator('.navigator-reset').click()
    assert(Math.abs((await nav.boundingBox()).x + (await nav.boundingBox()).width - 464) < 2)
    await page.setViewportSize({ width: 1280, height: 800 })
    await nav.locator('.navigator-child').last().click()
    assert.equal(await page.locator('.member-editor').count(), 3, 'Navigation keeps previously open main and child editors')
    await nav.locator('.navigator-save').focus()
    await page.keyboard.press('Control+s')
    assert.equal(await page.locator('.group-member-child').last().locator('.member-editor').count(), 0, 'Keyboard save still works in a body-portal and folds only the active member')
    assert.equal(await page.locator('.member-editor').count(), 2)
    await nav.locator('.navigator-close').click()
    await nav.locator('.discard-close').click()
    assert.equal(await nav.count(), 0, 'Closing removes the portal')
    await page.locator('.group-edit').click()
    await mutate(() => { window.harness.showSettingsContent = false })
    assert.equal(await nav.count(), 0, 'Destroying settings also removes the portal')
    assert.equal(await page.locator('settings-tab-body').evaluate(node => getComputedStyle(node).maxWidth), '600px', 'Other settings providers get their original width back')
    assert.equal(await page.locator('settings-tab-body').evaluate(node => node.style.minWidth), '', 'The temporary minimum width is also restored')
    console.log('PASS navigator dragging covers menus/editors, survives scroll, clamps on resize, resets right and preserves keyboard save/cleanup')
}
