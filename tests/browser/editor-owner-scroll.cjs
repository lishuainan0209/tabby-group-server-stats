const assert = require('node:assert/strict')

module.exports = async function editorOwnerScroll(page) {
    await page.setViewportSize({ width: 1100, height: 720 })
    await page.reload()
    await page.waitForFunction(() => window.ready)
    await page.evaluate(() => {
        const h = window.harness
        const metric = id => ({ id, label: id, command: 'printf 1', type: 'text' })
        h.config.store.plugin.serverStats.metricGroups = [{
            id: 'owner-scroll-group', label: 'Owner scroll group', mode: 'static', layout: 'vertical',
            main: metric('owner-scroll-main'), children: [metric('owner-scroll-child')],
        }]
        h.showSettings = true
        window.tick()
    })
    await page.locator('.settings .group-edit').click()
    await page.locator('.editor-navigator:visible .navigator-main').click()
    await page.locator('.editor-navigator:visible .navigator-child').click()
    // Keep the first view cached, as Tabby does when switching settings tabs.
    await page.locator('.settings').evaluate(node => { node.style.display = 'none' })
    await page.evaluate(() => { window.harness.showOtherSettings = true; window.tick() })
    await page.locator('.other-settings .group-edit').click()
    await page.waitForFunction(() => document.querySelectorAll('.editor-navigator').length === 2 &&
        [...document.querySelectorAll('.editor-navigator')].filter(node => getComputedStyle(node).display !== 'none').length === 1)

    await page.evaluate(() => {
        window.editorScrollCalls = []
        const original = Element.prototype.scrollIntoView
        window.editorOriginalScrollIntoView = original
        Element.prototype.scrollIntoView = function (...args) {
            window.editorScrollCalls.push(this.closest('.settings,.other-settings')?.className)
            return original.apply(this, args)
        }
    })
    const navigator = page.locator('.editor-navigator:visible')
    for (const member of ['main', 'child']) {
        await page.evaluate(() => { window.editorScrollCalls = [] })
        await navigator.locator(`.navigator-${member}`).click()
        await page.waitForFunction(() => window.editorScrollCalls.length > 0)
        assert.equal(await page.locator(`[id="member-editor-owner-scroll-${member}"]`).count(), 2,
            'Both cached settings views contain the same persisted metric ID')
        assert.deepEqual(await page.evaluate(() => window.editorScrollCalls), ['other-settings'],
            `The ${member} navigator must scroll its own settings instance, not the hidden first editor`)
    }

    await page.evaluate(() => { window.harness.showOtherSettings = false; window.tick(); window.editorScrollCalls = [] })
    await page.locator('.settings').evaluate(node => { node.style.display = '' })
    await page.locator('.editor-navigator:visible .navigator-main').click()
    await page.waitForFunction(() => window.editorScrollCalls.length > 0)
    assert.deepEqual(await page.evaluate(() => window.editorScrollCalls), ['settings'],
        'Returning to the cached settings view restores navigation to that owner')
    await page.evaluate(() => {
        Element.prototype.scrollIntoView = window.editorOriginalScrollIntoView
        delete window.editorOriginalScrollIntoView
        delete window.editorScrollCalls
    })
    console.log('PASS editor navigation with duplicate metric IDs stays inside its owning settings instance')
}
