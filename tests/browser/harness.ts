import 'reflect-metadata'
import 'zone.js'
import '@angular/compiler'
import { Component, NgModule, ApplicationRef, Input, ViewChild, AfterViewInit } from '@angular/core'
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

const metric = (id: string, label: string): any => ({ id, label, command: 'printf 63', type: 'text', suffix: '%', detailCommand: 'printf details' })
@Component({
    selector: 'visibility-pane',
    template: `<div class="visibility-terminal">same-user@same-server:~$</div><server-stats-bottom-bar></server-stats-bottom-bar>`,
    styles: [`:host{display:flex;flex-direction:column;position:relative;background:#171c25;border:1px solid #ffffff40;min-width:260px;height:120px}.visibility-terminal{flex:1;min-height:0;padding:10px;font:12px monospace;color:#82dba0}`]
})
class VisibilityPane implements AfterViewInit {
    @Input() session: any
    @ViewChild(ServerStatsBottomBarComponent, { static: true }) bar: ServerStatsBottomBarComponent
    ngAfterViewInit() {
        this.bar.useExternalController = true
        this.bar.externalSessionResolver = () => this.session
        setTimeout(() => { this.bar.bindToSession(this.session); this.bar.renderExternalStats((window as any).harness.stats) })
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
      <div class="settings" *ngIf="showSettings"><server-stats-settings></server-stats-settings></div>
      <section class="visibility-demo" *ngIf="showVisibilityDemo"><visibility-pane *ngFor="let pane of visibilityPanes" [session]="pane"></visibility-pane></section>`,
    styles: [`.terminal { height: 200px; margin-top: 20px; background: #101218; padding: 18px; color: #82dba0; font: 14px monospace; } .bar { padding: 8px 14px; background:#171a22; backdrop-filter:blur(8px); border-top: 1px solid #ffffff30; } h2 { font-size: 22px; } p { color: #98a4b5; } .scope-panes { display:flex; gap:12px; } .scope-pane { flex:1; min-width:0; padding:12px; background:#171c25; border:1px solid #ffffff25; border-radius:6px; } .scope-terminal { color:#82dba0; height:70px; font:12px monospace; } h4 { margin:0 0 18px; }`]
})
class Harness {
    metrics = [metric('solo', '系统盘')]
    group: any = { id: 'disk', label: '磁盘', mode: 'carousel', layout: 'vertical', interval: 1, main: metric('main', '总览'), children: [metric('a', '/data1'), metric('b', '/data2'), metric('c', '/data3')] }
    stats: any = { custom: [{ id: 'solo', value: '42', status: 'ok' }, { id: 'main', value: '63', status: 'ok' }, { id: 'a', value: '52', status: 'ok' }, { id: 'b', value: '未挂载', status: 'unavailable' }, { id: 'c', value: '71', status: 'ok' }] }
    session = { open: true, id: 'demo' }
    detailCalls: string[][] = []
    detailDelay = 0
    detailResults: Record<string, string> = {}
    previewChinese = false
    showSettings = false
    showScopeDemo = false
    showVisibilityDemo = false
    visibilityPanes = [0, 1, 2].map(index => ({ open: true, id: `same-layout-pane-${index}`, profile: { id: 'same-connection' } }))
    paneVisibility: Record<string, boolean> = {}
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
        config.store.profiles = this.scopeProfiles
        ;(window as any).harness = this
    }
}
@NgModule({
    imports: [BrowserModule, CommonModule, FormsModule],
    declarations: [Harness, VisibilityPane, ServerStatsBottomBarComponent, MetricStripComponent, ServerStatsSettingsComponent, TranslatePipe, TranslateDirective],
    providers: [AppService, ConfigService, PlatformService, StatsService], bootstrap: [Harness]
})
class HarnessModule {}
platformBrowserDynamic().bootstrapModule(HarnessModule).then(ref => {
    (window as any).tick = () => ref.injector.get(ApplicationRef).tick()
    ;(window as any).ready = true
})
