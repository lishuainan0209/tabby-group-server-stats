const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

class Signal {
    subscribers = new Set();
    subscribe(fn) { this.subscribers.add(fn); return { unsubscribe: () => this.subscribers.delete(fn) }; }
    emit(value) { for (const fn of this.subscribers) fn(value); }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const stats = value => ({ cpu: value, mem: value, disk: value, netRx: 0, netTx: 0, custom: [{ id: 'disk', value: String(value), status: 'ok' }] });
const decorator = () => target => target;

function node() {
    return {
        children: [], parentNode: null, attrs: {}, classList: { add() {}, remove() {} },
        setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
        removeAttribute(k) { delete this.attrs[k]; },
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        removeChild(child) { this.children = this.children.filter(x => x !== child); child.parentNode = null; },
    };
}

function load(relative) {
    const intervals = [];
    const exports = {};
    let moduleMetadata;
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    const memberDecorator = () => () => undefined;
    const angular = { Component: decorator, NgModule: metadata => { moduleMetadata = metadata; return target => target; }, HostListener: memberDecorator, ViewChildren: memberDecorator, ViewChild: memberDecorator };
    const serviceClass = class {};
    const toolbarProvider = class {};
    const bottomComponent = class {}, floatingComponent = class {};
    const config = { DEFAULT_METRIC_ICONS: {}, evaluateColor: () => '#fff' };
    const context = {
        exports, console,
        require(name) {
            if (name === '@angular/core') return angular;
            if (name === 'tabby-core') return { ToolbarButtonProvider: toolbarProvider };
            if (name === 'fs' || name === 'os' || name === 'path') return require(name);
            if (name === './components/bottom-bar.component') return { ServerStatsBottomBarComponent: bottomComponent };
            if (name === './components/floating-panel.component') return { ServerStatsFloatingPanelComponent: floatingComponent };
            if (name.endsWith('/config')) return config;
            if (name.endsWith('/translations')) return { TRANSLATIONS: {} };
            if (name.endsWith('/services/stats.service')) return { StatsService: serviceClass };
            return {};
        },
        setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
        window: { setInterval(fn) { intervals.push(fn); return intervals.length; }, dispatchEvent() {} },
        document: { createElement: node }, Event: class {},
    };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true,
    } }).outputText, context);
    return { exports, intervals, moduleMetadata, toolbarProvider, bottomComponent, floatingComponent };
}

function componentFixture(kind) {
    const floating = kind === 'floating';
    const { exports } = load(`src/components/${floating ? 'floating-panel' : 'bottom-bar'}.component.ts`);
    const Component = exports[floating ? 'ServerStatsFloatingPanelComponent' : 'ServerStatsBottomBarComponent'];
    const requests = [];
    const paneVisibility = new WeakMap();
    const paneModes = new WeakMap();
    const service = {
        getServerKey: session => session.id, getCachedStats: () => null, isPlatformSupport: () => true,
        isPaneVisible: session => paneVisibility.get(session) !== false,
        setPaneVisible(session, visible) { paneVisibility.set(session, visible); config.changed$.emit(); },
        getPaneGroupMode: session => paneModes.get(session),
        setPaneGroupMode(session, mode) { paneModes.set(session, mode); config.changed$.emit(); },
        statsUpdated$: new Signal(), fetchStats(session) { const request = deferred(); requests.push({ ...request, session }); return request.promise; },
    };
    const config = { store: { plugin: { serverStats: { enabled: true, displayMode: floating ? 'floatingPanel' : 'bottomBar' } } }, changed$: new Signal(), ready$: new Signal() };
    const A = { id: 'A', open: true }, B = { id: 'B', open: true };
    const app = { activeTab: { session: A, frontend: {} }, activeTabChange: new Signal() };
    const render = { calls: 0, destroyed: false };
    const cdr = { detectChanges() { assert.equal(render.destroyed, false, 'destroyed view must never be updated'); render.calls++; } };
    const component = new Component(service, config, app, cdr, { runOutsideAngular() {}, run: fn => fn() }, {});
    return { component, service, config, app, requests, A, B, render };
}

test('saving a same-ID static group replaces labels and clears old readings before new collection', async () => {
    const f = componentFixture('bottom');
    const original = { id: 'p3-group', label: 'P3磁盘', mode: 'static', layout: 'vertical',
        main: { id: 'main', label: 'Total', type: 'text', command: 'printf 1' },
        children: [{ id: 'child', label: '/lsn_disk1', type: 'text', command: 'printf old' }] };
    f.config.store.plugin.serverStats.metricGroups = [original];
    f.service.getVisibleConfig = () => ({ customMetrics: [], metricGroups: f.config.store.plugin.serverStats.metricGroups });
    f.component.ngOnInit();
    f.component.currentStats = stats(10);
    const oldCollection = f.component.checkAndFetch();
    assert.equal(f.component.metricGroups[0].children[0].label, '/lsn_disk1');
    f.config.store.plugin.serverStats.metricGroups = [{ ...original, children: [{ ...original.children[0], label: '/data2', command: 'printf new' }] }];
    f.config.changed$.emit();
    assert.equal(f.component.metricGroups[0].children[0].label, '/data2');
    assert.equal(f.component.metricGroups[0].children[0].command, 'printf new');
    assert.equal(f.component.currentStats.custom.length, 0, 'Do not pair the new label with the old value');
    assert.equal(f.component.loading, true);
    assert.equal(f.requests.length, 2, 'A standalone bar starts collection on Save, without waiting for its timer');
    f.requests[0].resolve(stats(11));
    await oldCollection;
    assert.equal(f.component.currentStats.custom.length, 0, 'Old in-flight data cannot repaint after Save');
    f.requests[1].resolve(stats(22));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.component.currentStats.cpu, 22);
    assert.equal(f.component.loading, false);
    f.component.ngOnDestroy();
});

for (const kind of ['bottom', 'floating']) {
    test(`${kind}: a delayed result from A never overwrites B or supplies B hover data`, async () => {
        const f = componentFixture(kind);
        const first = f.component.checkAndFetch();
        f.component.hoveredCustom = 'disk';
        f.app.activeTab = { session: f.B, frontend: {} };
        const second = f.component.checkAndFetch();
        assert.equal(f.component.currentStats.custom.length, 0);
        if (kind === 'floating') assert.equal(f.component.hoveredCustom, null);
        f.requests[0].resolve(stats(11));
        await first;
        assert.notEqual(f.component.currentStats.cpu, 11);
        f.requests[1].resolve(stats(22));
        await second;
        assert.equal(f.component.currentStats.cpu, 22);
        assert.equal(kind === 'floating' ? f.component.metricSession : f.component.displaySession, f.B);
    });

    test(`${kind}: disabled and destroyed views reject delayed results and stream events`, async () => {
        const f = componentFixture(kind);
        f.component.ngOnInit();
        const pending = f.component.checkAndFetch();
        f.config.store.plugin.serverStats.enabled = false;
        f.config.changed$.emit();
        f.service.statsUpdated$.emit({ serverKey: 'A', stats: stats(99) });
        f.requests[0].resolve(stats(55));
        await pending;
        assert.equal(f.component.visible, false);
        assert.notEqual(f.component.currentStats.cpu, 55);
        f.config.store.plugin.serverStats.enabled = true;
        const late = f.component.checkAndFetch();
        f.component.ngOnDestroy();
        f.render.destroyed = true;
        const calls = f.render.calls;
        f.requests[1].resolve(stats(66));
        await late;
        f.service.statsUpdated$.emit({ serverKey: 'A', stats: stats(77) });
        assert.equal(f.render.calls, calls);
        assert.notEqual(f.component.currentStats.cpu, 66);
    });
}

test('legacy floating display preferences render the bottom bar and still respect enabled state', async () => {
    const f = componentFixture('bottom');
    f.config.store.plugin.serverStats.displayMode = 'floatingPanel';
    f.component.ngOnInit();
    const pending = f.component.checkAndFetch();
    assert.equal(f.requests.length, 1, 'legacy floating setting must not skip bottom-bar collection');
    f.requests[0].resolve(stats(28));
    await pending;
    assert.equal(f.component.visible, true);
    assert.equal(f.component.currentStats.cpu, 28);
    f.config.store.plugin.serverStats.enabled = false;
    f.config.changed$.emit();
    assert.equal(f.component.visible, false);
    f.component.ngOnDestroy();
});

test('legacy floating preferences also render externally controlled per-pane bars', () => {
    const f = componentFixture('bottom');
    f.config.store.plugin.serverStats.displayMode = 'floatingPanel';
    f.component.useExternalController = true;
    f.component.bindToSession(f.A);
    f.component.renderExternalStats(stats(29));
    assert.equal(f.component.visible, true);
    assert.equal(f.component.currentStats.cpu, 29);
    f.component.ngOnDestroy();
});

test('the pane button hides only its own same-profile pane and stays available to reopen it', () => {
    const first = componentFixture('bottom'), second = componentFixture('bottom');
    first.A.profile = second.A.profile = { id: 'same-saved-connection' };
    second.component.statsService = first.service;
    for (const f of [first, second]) {
        f.component.useExternalController = true;
        f.component.bindToSession(f.A);
        f.component.ngOnInit();
        f.component.renderExternalStats(stats(10));
    }
    first.component.togglePaneVisibility();
    assert.equal(first.component.visible, true, 'eligibility stays true so the reopen control remains');
    assert.equal(first.component.paneVisible, false);
    assert.equal(first.config.store.plugin.serverStats.enabled, true, 'the master switch must not change');
    second.component.loadConfig();
    assert.equal(second.component.paneVisible, true, 'another session of the same profile stays open');
    first.component.togglePaneVisibility();
    assert.equal(first.component.paneVisible, true);
    assert.equal(second.component.paneVisible, true);
    first.component.ngOnDestroy(); second.component.ngOnDestroy();
});

test('collapsed bars do not fetch or accept late value/stream results and can resume', async () => {
    const f = componentFixture('bottom');
    f.component.ngOnInit();
    const pending = f.component.checkAndFetch();
    f.component.togglePaneVisibility();
    assert.equal(f.component.paneVisible, false);
    f.requests[0].resolve(stats(88));
    await pending;
    assert.notEqual(f.component.currentStats.cpu, 88);
    f.service.statsUpdated$.emit({ serverKey: 'A', stats: stats(99) });
    assert.notEqual(f.component.currentStats.cpu, 99);
    await f.component.checkAndFetch();
    assert.equal(f.requests.length, 1, 'collapsed polling must not start another request');
    assert.equal(f.component.visible, true);
    f.component.togglePaneVisibility();
    assert.equal(f.requests.length, 2, 'reopening resumes collection');
    f.requests[1].resolve(stats(42));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.component.currentStats.cpu, 42);
    f.component.ngOnDestroy();
});

test('the pane menu opens without toggling visibility and applies modes to view copies only', async () => {
    const f = componentFixture('bottom');
    const groups = [
        { id: 'disk', mode: 'overview', layout: 'horizontal', main: { id: 'disk-total' }, children: [] },
        { id: 'gpu', mode: 'carousel', main: { id: 'gpu-total' }, children: [] },
    ];
    const singles = [{ id: 'single' }];
    const before = JSON.stringify(groups);
    f.service.getVisibleConfig = () => ({ customMetrics: singles, metricGroups: groups });
    f.component.ngOnInit();
    assert.equal(f.component.metricGroups, groups, 'configured per-group modes remain until an override is selected');
    f.component.togglePaneMenu();
    assert.equal(f.component.menuOpen, true);
    assert.equal(f.component.paneVisible, true);
    assert.equal(f.requests.length, 0, 'opening the menu must not start a collection');
    f.component.setPaneVisibility(false);
    assert.equal(f.component.menuOpen, false);
    assert.equal(f.component.visible, true, 'the menu trigger survives hiding the metrics');
    f.component.togglePaneMenu();
    f.component.setPaneGroupMode('static');
    assert.equal(f.component.menuOpen, false);
    assert.equal(f.component.paneVisible, true, 'choosing a display mode shows a hidden pane');
    assert.equal(f.service.isPaneVisible(f.A), true, 'visibility is saved together with the selected mode');
    assert.equal(f.service.getPaneGroupMode(f.A), 'static');
    assert.equal(f.service.getPaneGroupMode(f.B), undefined);
    assert.equal(f.component.customMetrics, singles);
    assert.deepEqual(Array.from(f.component.metricGroups, group => group.mode), ['static', 'static']);
    assert.deepEqual(Array.from(f.component.metricGroups, group => group.layout), ['horizontal', 'vertical']);
    assert.notEqual(f.component.metricGroups[0], groups[0]);
    assert.equal(JSON.stringify(groups), before);
    assert.equal(f.requests.length, 1, 'choosing a mode immediately resumes collection in a previously hidden pane');
    f.requests[0].resolve(stats(42));
    await f.requests[0].promise;
    await Promise.resolve();
    f.app.activeTab = { session: f.B, frontend: {} };
    f.component.loadConfig();
    assert.equal(f.component.metricGroups, groups, 'other panes retain the configured modes');
    assert.equal(f.component.paneGroupMode, undefined);
    f.component.ngOnDestroy();
});

test('pane menu keyboard navigation, outside interaction and lifecycle release focus safely', () => {
    const f = componentFixture('bottom');
    f.component.ngOnInit();
    let focused = -1, toggleFocus = 0;
    const buttons = Array.from({ length: 5 }, (_, index) => ({ focus() { focused = index; } }));
    const toggle = { focus() { toggleFocus++; }, contains: target => target === toggle };
    f.component.paneToggle = { nativeElement: toggle };
    f.component.paneMenu = { nativeElement: {
        querySelectorAll: () => buttons, contains: target => buttons.includes(target),
    } };
    const event = (key, target) => ({ key, target, preventDefault() {}, stopPropagation() {} });
    f.component.togglePaneMenu();
    assert.equal(focused, 0);
    f.component.onMenuKeydown(event('ArrowUp', buttons[0]));
    assert.equal(focused, 4);
    f.component.onMenuKeydown(event('Home', buttons[4]));
    assert.equal(focused, 0);
    f.component.onMenuKeydown(event('End', buttons[0]));
    assert.equal(focused, 4);
    f.component.onMenuKeydown(event('ArrowDown', buttons[4]));
    assert.equal(focused, 0);
    f.component.onOutsideInteraction({ target: buttons[2] });
    assert.equal(f.component.menuOpen, true, 'interactions inside the menu stay open until selection');
    f.component.onDocumentKeydown(event('Escape', buttons[0]));
    assert.equal(f.component.menuOpen, false);
    assert.equal(toggleFocus, 1);
    f.component.onToggleKeydown(event('ArrowUp', toggle));
    assert.equal(f.component.menuOpen, true);
    assert.equal(focused, 4);
    f.component.onOutsideInteraction({ target: {} });
    assert.equal(f.component.menuOpen, false);
    assert.equal(toggleFocus, 1, 'outside pointer focus must not be stolen');
    f.component.togglePaneMenu();
    f.component.onMenuKeydown(event('Tab', buttons[0]));
    assert.equal(f.component.menuOpen, false);
    f.component.togglePaneMenu();
    f.app.activeTab = { session: f.B, frontend: {} };
    f.component.loadConfig();
    assert.equal(f.component.menuOpen, false, 'a menu must not carry commands into a replacement session');
    f.component.togglePaneMenu();
    f.component.ngOnDestroy();
    f.render.destroyed = true;
    const calls = f.render.calls;
    assert.equal(f.component.menuOpen, false);
    f.component.onOutsideInteraction({ target: {} });
    f.component.onDocumentKeydown(event('Escape', buttons[0]));
    f.component.togglePaneMenu();
    f.component.setPaneGroupMode('overview');
    assert.equal(f.render.calls, calls);
    assert.equal(f.config.changed$.subscribers.size, 0);
    assert.equal(f.service.statsUpdated$.subscribers.size, 0);
});

test('plugin registration exposes only the bottom view and no toolbar toggle', () => {
    const f = load('src/index.ts');
    assert(f.moduleMetadata.declarations.includes(f.bottomComponent));
    assert(f.moduleMetadata.entryComponents.includes(f.bottomComponent));
    assert(!f.moduleMetadata.declarations.includes(f.floatingComponent));
    assert(!f.moduleMetadata.entryComponents.includes(f.floatingComponent));
    assert(!f.moduleMetadata.providers.some(provider => provider.provide === f.toolbarProvider));
});

test('external bottom-bar binding clears previous data without a new session cache', () => {
    const f = componentFixture('bottom');
    f.component.useExternalController = true;
    f.component.bindToSession(f.A);
    f.component.renderExternalStats(stats(31));
    f.component.bindToSession(f.B);
    assert.equal(f.component.currentStats.custom.length, 0);
    assert.equal(f.component.loading, true);
    assert.equal(f.component.displaySession, f.B);
    f.component.bindToSession(null);
    assert.equal(f.component.resolveSession(), null, 'unbound external bar must not use another active tab');
    assert.equal(f.component.visible, false);
});

test('external bar stream events recheck the live session before the next poll', () => {
    const f = componentFixture('bottom');
    let liveSession = f.A;
    f.component.useExternalController = true;
    f.component.externalSessionResolver = () => liveSession;
    f.component.bindToSession(f.A);
    f.component.ngOnInit();
    f.component.renderExternalStats(stats(31));
    liveSession = f.B;
    f.service.statsUpdated$.emit({ serverKey: 'A', stats: stats(99) });
    assert.equal(f.component.displaySession, f.B);
    assert.equal(f.component.currentStats.custom.length, 0);
    assert.notEqual(f.component.currentStats.cpu, 99);
});

function moduleFixture() {
    const { exports, intervals } = load('src/index.ts');
    const module = Object.create(exports.default.prototype);
    const requests = [];
    const calls = [];
    const A = { id: 'A', open: true }, B = { id: 'B', open: true };
    const state = { session: A, destroyed: false };
    const invoke = name => (...args) => { assert.equal(state.destroyed, false); calls.push({ name, args }); };
    const barRef = {
        instance: { useExternalController: false, bindToSession: invoke('bind'), hideExternal: invoke('hide'), renderExternalStats: invoke('render'), setExternalLoading: invoke('loading') },
        hostView: { rootNodes: [node()] }, changeDetectorRef: { detectChanges: invoke('detect') }, destroy() { state.destroyed = true; },
    };
    Object.assign(module, {
        activeDisplayMode: 'bottomBar', tabInstances: new WeakMap(), attachedTabs: new Set(),
        app: { tabsChanged$: new Signal() },
        componentFactoryResolver: { resolveComponentFactory: () => ({ create: () => barRef }) }, injector: {},
        appRef: { attachView() {}, detachView() {} },
        config: { store: { plugin: { serverStats: { enabled: true, displayMode: 'bottomBar' } } }, changed$: new Signal() },
        statsService: { isPlatformSupport: () => true, fetchStats(session) { calls.push({ name: 'fetch', args: [session] }); const request = deferred(); requests.push({ ...request, session }); return request.promise; } },
        rebuildTabElementMap() {}, resolveSessionForElement: () => state.session,
        resolveTabForElement: () => ({ session: state.session, frontend: {} }),
    });
    const element = node();
    module.attachToSshTab(element);
    return { module, state, A, B, calls, requests, element, barRef, poll: intervals[0], instance: module.tabInstances.get(element) };
}

test('per-pane controller continues polling with a legacy floating setting', async () => {
    const f = moduleFixture();
    f.module.config.store.plugin.serverStats.displayMode = 'floatingPanel';
    assert.equal(f.module.getDisplayMode(), 'bottomBar');
    const pending = f.poll();
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve(stats(30));
    await pending;
    assert.equal(f.calls.filter(call => call.name === 'render').at(-1).args[0].cpu, 30);
    f.instance.teardown();
});

test('external controller skips hidden panes and discards responses hidden during collection', async () => {
    const f = moduleFixture();
    let paneVisible = false;
    f.module.statsService.isPaneVisible = () => paneVisible;
    await f.poll();
    assert.equal(f.requests.length, 0);
    assert.equal(f.calls.at(-1).name, 'loading');
    assert.equal(f.calls.at(-1).args[0], false, 'the reopen button remains while loading stops');
    assert(!f.calls.some(call => call.name === 'hide'), 'collapsed panes must keep their control');
    paneVisible = true;
    const pending = f.poll();
    assert.equal(f.requests.length, 1);
    paneVisible = false;
    f.requests[0].resolve(stats(99));
    await pending;
    assert.equal(f.calls.filter(call => call.name === 'render').length, 0);
    paneVisible = true;
    const reopened = f.poll();
    f.requests[1].resolve(stats(17));
    await reopened;
    assert.equal(f.calls.filter(call => call.name === 'render').at(-1).args[0].cpu, 17);
    f.instance.teardown();
});

test('saving configuration starts external recollection immediately and shows a pending state', async () => {
    const f = moduleFixture();
    const initial = f.poll();
    f.requests[0].resolve(stats(21));
    await initial;
    f.module.config.changed$.emit();
    const loading = f.calls.filter(call => call.name === 'loading').at(-1);
    assert.equal(loading.args[0], true);
    assert.equal(f.requests.length, 2, 'Save starts collection immediately, without waiting for the poll timer');
    f.requests[1].resolve(stats(22));
    await f.requests[1].promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(call => call.name === 'render').at(-1).args[0].cpu, 22);
    f.instance.teardown();
});

test('configuration saves rebind newly associated labels and never reopen a hidden pane', async () => {
    const bar = componentFixture('bottom');
    bar.component.useExternalController = true;
    bar.component.bindToSession(bar.A);
    let visible = { customMetrics: [], metricGroups: [] };
    bar.service.getVisibleConfig = () => visible;
    bar.component.ngOnInit();
    bar.component.renderExternalStats(stats(7));
    visible = { customMetrics: [{ id: 'associated', label: 'New binding' }], metricGroups: [] };
    bar.config.changed$.emit();
    assert.equal(bar.component.customMetrics[0].id, 'associated');
    assert.equal(bar.component.currentStats.custom.length, 0);
    visible = { customMetrics: [], metricGroups: [] };
    bar.config.changed$.emit();
    assert.equal(bar.component.customMetrics.length, 0, 'Deletion is reflected before any new SSH result');
    bar.component.setPaneVisibility(false);
    bar.config.changed$.emit();
    assert.equal(bar.component.paneVisible, false);
    assert.equal(bar.component.loading, false);
    bar.component.ngOnDestroy();
    const f = moduleFixture();
    f.module.statsService.isPaneVisible = () => false;
    f.module.config.changed$.emit();
    await Promise.resolve();
    assert.equal(f.requests.length, 0);
    assert.equal(f.calls.filter(call => call.name === 'render').length, 0);
    f.instance.teardown();
});

test('external collector refreshes same-session scope and renders it before a pending fetch', async () => {
    const bar = componentFixture('bottom');
    const f = moduleFixture();
    let scope = { customMetrics: [{ id: 'old-layout' }], metricGroups: [{ id: 'old-group' }] };
    bar.service.getVisibleConfig = () => scope;
    bar.component.useExternalController = true;
    bar.component.bindToSession(f.A);
    bar.component.renderExternalStats(stats(31));
    const originalBind = f.barRef.instance.bindToSession;
    f.barRef.instance.bindToSession = session => {
        originalBind(session);
        bar.component.bindToSession(session);
    };

    // Moving the pane changes its layout scope while retaining the same SSH session.
    scope = { customMetrics: [{ id: 'new-layout' }], metricGroups: [{ id: 'new-group' }] };
    const renderedBefore = bar.render.calls;
    const callsBefore = f.calls.length;
    const pending = f.poll();
    assert.equal(f.requests.length, 1, 'the replacement collection remains pending');
    assert.equal(bar.component.displaySession, f.A);
    assert.deepEqual(bar.component.customMetrics, scope.customMetrics);
    assert.deepEqual(bar.component.metricGroups, scope.metricGroups);
    assert.ok(bar.render.calls > renderedBefore, 'scope removal must reach the view without awaiting SSH');
    assert.deepEqual(f.calls.slice(callsBefore).map(c => c.name), ['bind', 'fetch']);
    assert.equal(f.calls.filter(c => c.name === 'render').length, 0);

    f.requests[0].resolve(stats(41));
    await pending;
    f.instance.teardown();
    bar.component.ngOnDestroy();
});

test('layout changes immediately rebind an unchanged session and collect its new scope', async () => {
    const f = moduleFixture();
    const callsBefore = f.calls.length;
    assert.equal(f.module.app.tabsChanged$.subscribers.size, 1);
    f.module.app.tabsChanged$.emit();
    assert.equal(f.requests.length, 1, 'layout changes must not wait for the interval');
    assert.equal(f.requests[0].session, f.A);
    assert.deepEqual(f.calls.slice(callsBefore).map(c => c.name), ['bind', 'fetch']);
    f.requests[0].resolve(stats(42));
    await f.requests[0].promise;
    await Promise.resolve();
    f.instance.teardown();
});

test('teardown removes layout listeners and prevents new work while a layout poll is pending', async () => {
    const f = moduleFixture();
    f.module.app.tabsChanged$.emit();
    assert.equal(f.requests.length, 1);
    f.instance.teardown();
    assert.equal(f.module.app.tabsChanged$.subscribers.size, 0);
    assert.equal(f.module.config.changed$.subscribers.size, 0);
    const callsBefore = f.calls.length;
    f.module.app.tabsChanged$.emit();
    f.module.config.changed$.emit();
    f.requests[0].resolve(stats(43));
    await f.requests[0].promise;
    await Promise.resolve();
    await f.poll();
    assert.equal(f.requests.length, 1);
    assert.equal(f.calls.length, callsBefore, 'late results must not access the destroyed view');
});

test('external collector does not relabel A results as B during overlapping polls', async () => {
    const f = moduleFixture();
    const first = f.poll();
    f.state.session = f.B;
    const second = f.poll();
    f.requests[0].resolve(stats(10));
    await first;
    assert.equal(f.calls.filter(c => c.name === 'render').length, 0);
    f.requests[1].resolve(stats(20));
    await second;
    const rendered = f.calls.filter(c => c.name === 'render');
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].args[0].cpu, 20);
});

test('external poll completion after teardown never calls the destroyed component', async () => {
    const f = moduleFixture();
    const pending = f.poll();
    f.instance.teardown();
    const count = f.calls.length;
    f.requests[0].resolve(stats(45));
    await pending;
    await f.poll();
    assert.equal(f.calls.length, count);
});

test('external poll checks enabled setting after await even without a config event', async () => {
    const f = moduleFixture();
    const pending = f.poll();
    f.module.config.store.plugin.serverStats.enabled = false;
    f.requests[0].resolve(stats(35));
    await pending;
    assert.equal(f.calls.filter(c => c.name === 'render').length, 0);
    assert.equal(f.calls.at(-1).name, 'hide');
});
