import 'reflect-metadata'
import 'zone.js'
import '@angular/compiler'
import { Component, NgModule, ApplicationRef, Input, ViewChild, AfterViewInit, OnDestroy, HostListener, ElementRef, NgZone } from '@angular/core'
import { Subscription } from 'rxjs'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { BrowserModule } from '@angular/platform-browser'
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'
import { MetricStripComponent } from '../../src/components/metric-strip.component'
import { ServerStatsSettingsComponent } from '../../src/components/settings.component'
import { ServerStatsBottomBarComponent } from '../../src/components/bottom-bar.component'
import { AppService, ConfigService, PlatformService, TranslatePipe, TranslateDirective } from './tabby.mock'
import { StatsService } from './stats.mock'
import { filterScopedMetrics } from '../../src/display-scope'
import { ServerStatsConfigProvider } from '../../src/config'

const metric = (id: string, label: string): any => ({ id, label, command: 'printf 63', type: 'text', suffix: '%', detailCommand: 'printf details' })
// Match Tabby's provider container, including the 600px cap that previously
// crushed the editor when navigation padding was subtracted from its width.
@Component({
    selector: 'settings-tab-body',
    template: '<ng-content></ng-content>',
    styles: [':host { display: block; padding-bottom: 20px; max-width: 600px; }'],
})
class SettingsBodyFixture {}
@Component({
    selector: 'visibility-pane',
    template: `<div class="visibility-terminal" tabindex="-1">same-user@same-server:~$</div><server-stats-bottom-bar></server-stats-bottom-bar>`,
    styles: [`:host{display:flex;flex-direction:column;position:relative;background:#171c25;border:1px solid #ffffff40;min-width:260px;height:120px}.visibility-terminal{flex:1;min-height:0;padding:10px;font:12px monospace;color:#82dba0}`]
})
class VisibilityPane implements AfterViewInit, OnDestroy {
    private configSubscription?: Subscription
    private destroyed = false
    constructor(private element: ElementRef<HTMLElement>, private config: ConfigService) {}
    // Tabby refocuses the terminal on each bubbled mousemove, even in the same pane.
    @HostListener('mousemove') followMouseFocus() {
        if ((window as any).harness.focusFollowsMouse) this.element.nativeElement.querySelector<HTMLElement>('.visibility-terminal')?.focus();
    }
    @Input() session: any
    @ViewChild(ServerStatsBottomBarComponent, { static: true }) bar: ServerStatsBottomBarComponent
    ngAfterViewInit() {
        this.bar.useExternalController = true
        this.bar.externalSessionResolver = () => this.session
        setTimeout(() => { this.bar.bindToSession(this.session); this.bar.renderExternalStats((window as any).harness.stats) })
        // The real plugin's external controller recollects after configuration saves.
        // This harness supplies its mocked completion after BottomBar invalidates
        // old readings; real collection/cancellation is covered by backend tests.
        this.configSubscription = this.config.changed$.subscribe(() => {
            Promise.resolve().then(() => {
                if (!this.destroyed) this.bar.renderExternalStats((window as any).harness.stats)
            })
        })
    }
    ngOnDestroy() {
        this.destroyed = true
        this.configSubscription?.unsubscribe()
    }
}
@Component({
    selector: 'test-app',
    template: `<h2>服务器状态 · 标签组验证</h2><p>磁盘状态、悬停详情与轮播</p>
      <div class="terminal">user@server:~$<span class="cursor">▌</span></div>
      <div class="bar"><server-stats-metric-strip [metrics]="metrics" [groups]="[group]" [stats]="stats" [session]="session"></server-stats-metric-strip></div>
      <section *ngIf="showScopeDemo" class="scope-demo"><h3>混合布局 · 按窗格连接匹配</h3>
        <div class="scope-panes"><div *ngFor="let pane of scopePanes" class="scope-pane" [attr.data-profile]="pane.profileId">
          <h4>{{pane.label}}</h4><div class="scope-terminal">{{pane.profileId}}@server:~$</div>
          <server-stats-metric-strip [metrics]="visibleFor(pane).customMetrics" [groups]="visibleFor(pane).metricGroups" [stats]="scopeStats" [session]="pane.session"></server-stats-metric-strip>
        </div></div>
      </section>
      <div class="settings" [class.host-settings]="hostedSettings" *ngIf="showSettings">
        <nav class="host-sidebar" *ngIf="hostedSettings">设置<br>终端<br>插件<br>服务器状态</nav>
        <div class="host-content"><settings-tab-body><server-stats-settings *ngIf="showSettingsContent"></server-stats-settings></settings-tab-body></div>
      </div>
      <section class="visibility-demo" *ngIf="showVisibilityDemo"><visibility-pane *ngFor="let pane of visibilityPanes" [session]="pane"></visibility-pane></section>`,
    styles: [`.host-settings { display:flex; position:fixed; inset:34px 0 0; z-index:20; background:#11151c; } .host-sidebar { flex:0 0 222px; padding:20px; border-right:1px solid #ffffff30; line-height:3; } .host-settings .host-content { flex:1; min-width:0; overflow:auto; padding:20px 30px; transform:translateZ(0); } .terminal { height: 200px; margin-top: 20px; background: #101218; padding: 18px; color: #82dba0; font: 14px monospace; } .bar { padding: 8px 14px; background:#171a22; backdrop-filter:blur(8px); border-top: 1px solid #ffffff30; } h2 { font-size: 22px; } p { color: #98a4b5; } .scope-panes { display:flex; gap:12px; } .scope-pane { flex:1; min-width:0; padding:12px; background:#171c25; border:1px solid #ffffff25; border-radius:6px; } .scope-terminal { color:#82dba0; height:70px; font:12px monospace; } h4 { margin:0 0 18px; }`]
})
class Harness {
    metrics = [metric('solo', '系统盘')]
    group: any = { id: 'disk', label: '磁盘', mode: 'carousel', layout: 'vertical', interval: 1, main: metric('main', '总览'), children: [metric('a', '/data1'), metric('b', '/data2'), metric('c', '/data3')] }
    stats: any = { custom: [{ id: 'solo', value: '42', status: 'ok' }, { id: 'main', value: '63', status: 'ok' }, { id: 'a', value: '52', status: 'ok' }, { id: 'b', value: '未挂载', status: 'unavailable' }, { id: 'c', value: '71', status: 'ok' }] }
    session = { open: true, id: 'demo' }
    detailCalls: string[][] = []
    detailRequests: { ids: string[]; options?: any }[] = []
    hoverCalls: { ids: string[]; force: boolean; at: number }[] = []
    hoverBlockedIds: string[] = []
    hoverResolvers: Record<string, () => void> = {}
    detailDelay = 0
    detailThrows = false
    detailResults: Record<string, string> = {}
    previewChinese = false
    showSettings = false
    hostedSettings = false
    showSettingsContent = true
    showScopeDemo = false
    showVisibilityDemo = false
    focusFollowsMouse = false
    visibilityPanes = [0, 1, 2].map(index => ({ open: true, id: `same-layout-pane-${index}`, profile: { id: 'same-connection' } }))
    paneVisibility: Record<string, boolean> = {}
    paneGroupModes: Record<string, 'overview' | 'carousel' | 'static'> = {}
    scopeProfiles = [{ id: 'p1', name: 'P1', type: 'ssh' }, { id: 'p2', name: 'P2', type: 'ssh' }, { id: 'layout', name: '混合三窗口', type: 'split-layout' }]
    scopePanes = ['p1', 'p2', 'p1'].map((profileId, i) => ({ profileId, label: `窗格 ${i + 1} · ${profileId.toUpperCase()}`, session: { open: true, id: `pane${i}` } }))
    scopeConfig: any = {
        customMetrics: [
            { ...metric('common', '公共指标'), detailCommand: '' },
            { ...metric('p1disk', 'P1 数据盘'), detailCommand: '', displayScope: { mode: 'selected', profileIds: ['p1'] } },
            { ...metric('p2gpu', 'P2 GPU'), detailCommand: '', displayScope: { mode: 'selected', profileIds: ['p2'] } },
        ], metricGroups: [
            { id: 'layout-health', label: '', mode: 'overview', layout: 'vertical', displayScope: { mode: 'selected', profileIds: ['layout'] }, main: { ...metric('health', '布局公共状态'), suffix: '', detailCommand: '' }, children: [] }
        ]
    }
    scopeStats = { custom: [{ id: 'common', value: '40', status: 'ok' }, { id: 'p1disk', value: '63', status: 'ok' }, { id: 'p2gpu', value: '82', status: 'ok' }, { id: 'health', value: '正常', status: 'ok' }] }
    visibleFor(pane: any) { return filterScopedMetrics(this.scopeConfig, { profileIds: [pane.profileId, 'layout'] }, this.scopeProfiles) }
    constructor(public config: ConfigService) {
        config.useHostConfig(new ServerStatsConfigProvider().defaults)
        config.store.profiles = this.scopeProfiles
        ;(window as any).harness = this
    }
}
@NgModule({
    imports: [BrowserModule, CommonModule, FormsModule],
    declarations: [Harness, SettingsBodyFixture, VisibilityPane, ServerStatsBottomBarComponent, MetricStripComponent, ServerStatsSettingsComponent, TranslatePipe, TranslateDirective],
    providers: [AppService, ConfigService, PlatformService, StatsService], bootstrap: [Harness]
})
class HarnessModule {}
platformBrowserDynamic().bootstrapModule(HarnessModule).then(ref => {
    (window as any).tick = () => ref.injector.get(NgZone).run(() => ref.injector.get(ApplicationRef).tick())
    ;(window as any).ready = true
})
