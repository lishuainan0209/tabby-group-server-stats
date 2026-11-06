import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { Subscription } from 'rxjs'
import { AppService, ConfigService } from 'tabby-core'
import { StatsService } from '../services/stats.service'
import { CustomMetric, CustomMetricGroup } from '../config'
import { BuiltinMetricKey } from '../builtin-metrics'

@Component({
    selector: 'server-stats-bottom-bar',
    template: `
        <div class="stats-container" 
             *ngIf="visible"
             [style.background]="styleConfig.background">
            <div class="stat-section" *ngIf="loading">
                <div class="loading-text">Loading...</div>
            </div>
            
            <server-stats-metric-strip *ngIf="!loading" [metrics]="customMetrics" [groups]="metricGroups"
                [builtinOrder]="builtinOrder"
                [stats]="currentStats" [session]="displaySession"></server-stats-metric-strip>
        </div>
    `,
    styles: [`
        :host { display: block; width: 100%; position: relative; box-sizing: border-box; }
        .stats-container {
            position: relative;
            width: 100%;
            box-sizing: border-box;
            backdrop-filter: blur(8px);
            padding: 1px 12px;
            display: flex;
            flex-wrap: wrap;
            gap: 4px 10px;
            justify-content: flex-start;
            align-items: center;
            border-top: 1px solid rgba(255,255,255,0.15);
            color: rgba(255,255,255,0.9);
            user-select: none;
            font-size: 11px;
            min-height: 22px;
        }
        .stat-section { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; height: 20px; }
        .loading-text { color: rgba(255,255,255,0.6); font-size: 10px; font-style: italic; }
    `]
})
export class ServerStatsBottomBarComponent implements OnInit, OnDestroy {
    visible = false
    loading = true
    currentStats: any = { cpu: 0, mem: 0, disk: 0, netRx: 0, netTx: 0, custom: [] }
    customMetrics: CustomMetric[] = []
    metricGroups: CustomMetricGroup[] = []
    builtinOrder: BuiltinMetricKey[] = []
    
    public styleConfig = { background: 'rgba(20, 20, 20, 0.85)' }
    private timerId: any = null
    private tabSubscription: Subscription | null = null
    private configSubscriptions: Subscription[] = []
    private boundSession: any = null
    displaySession: any = null
    private destroyed = false
    private viewRevision = 0
    public useExternalController = false
    public externalSessionResolver: (() => any) | null = null

    constructor(
        private statsService: StatsService,
        private config: ConfigService,
        private app: AppService,
        private cdr: ChangeDetectorRef,
        private zone: NgZone,
        private sanitizer: DomSanitizer
    ) {
    }

    bindToSession(session: any) {
        if (this.destroyed) return;
        this.boundSession = session;
        this.synchronizeSession(session);
        this.visible = this.canDisplay(session);
        this.cdr.detectChanges();
    }

    private synchronizeSession(session: any) {
        this.applyMetricScope(session);
        if (this.displaySession === session) return;
        this.viewRevision++;
        this.displaySession = session;
        const cached = session?.open !== false && session ? this.statsService.getCachedStats(session) : null;
        this.currentStats = cached || { cpu: 0, mem: 0, disk: 0, netRx: 0, netTx: 0, custom: [] };
        this.loading = !cached;
    }

    private applyMetricScope(session: any) {
        const conf = this.config?.store?.plugin?.serverStats || {};
        const visible = this.statsService.getVisibleConfig?.(session) || conf;
        this.builtinOrder = conf.builtinOrder || [];
        this.customMetrics = visible.customMetrics || [];
        this.metricGroups = visible.metricGroups || [];
    }

    private canDisplay(session: any): boolean {
        const conf = this.config?.store?.plugin?.serverStats;
        return !this.destroyed && !!conf?.enabled && (conf.displayMode || 'bottomBar') === 'bottomBar' &&
            !!session && session.open !== false && this.resolveSession() === session;
    }

    private isCurrentRequest(session: any, revision: number): boolean {
        return this.viewRevision === revision && this.displaySession === session && this.canDisplay(session);
    }

    renderExternalStats(stats: any | null) {
        if (!this.canDisplay(this.boundSession)) return;
        this.synchronizeSession(this.boundSession);
        this.visible = true;
        if (stats) {
            this.visible = true;
            this.loading = false;
            this.updateStats(stats);
            this.currentStats = stats;
        } else {
            this.loading = false;
        }
        this.cdr.detectChanges();
    }

    setExternalLoading(isLoading: boolean) {
        if (!this.canDisplay(this.boundSession)) return;
        this.synchronizeSession(this.boundSession);
        this.visible = true;
        this.loading = isLoading;
        this.cdr.detectChanges();
    }

    hideExternal() {
        if (this.destroyed) return;
        this.viewRevision++;
        this.synchronizeSession(null);
        this.visible = false;
        this.loading = true;
        this.cdr.detectChanges();
    }

    resolveSession(): any {
        if (this.useExternalController && this.externalSessionResolver) return this.externalSessionResolver();
        if (this.useExternalController || this.boundSession) {
            return this.boundSession;
        }

        let activeTab: any = this.app.activeTab;
        if (!activeTab) {
            return null;
        }

        if (activeTab['focusedTab']) {
            activeTab = activeTab['focusedTab'];
        }

        return activeTab['session'] || null;
    }

    ngOnInit() {
        this.loadConfig();
        this.configSubscriptions.push(this.config.ready$.subscribe(() => {
            this.loadConfig();
            setTimeout(() => this.checkAndFetch(), 100);
        }));
        this.configSubscriptions.push(this.config.changed$.subscribe(() => this.loadConfig()));

        this.configSubscriptions.push(this.statsService.statsUpdated$.subscribe(event => {
            if (this.destroyed) return;
            const session = this.resolveSession();
            this.synchronizeSession(session);
            if (!this.canDisplay(session)) { this.hideExternal(); return; }
            if (this.canDisplay(session) && this.statsService.getServerKey(session) === event.serverKey) {
                this.visible = true;
                this.loading = false;
                this.updateStats(event.stats);
                this.currentStats = event.stats;
                this.cdr.detectChanges();
            } else {
                this.cdr.detectChanges();
            }
        }));

        if (this.useExternalController) {
            return;
        }

        if (!this.boundSession && (this.app as any).activeTabChange) {
            this.tabSubscription = (this.app as any).activeTabChange.subscribe(() => {
                this.checkAndFetch();
            });
        }
        setTimeout(() => this.checkAndFetch(), 100);
        this.zone.runOutsideAngular(() => {
            this.timerId = window.setInterval(() => {
                this.zone.run(() => { this.checkAndFetch() })
            }, 1000)
        })
    }

    loadConfig() {
        if (this.destroyed) return;
        this.viewRevision++;
        const conf = this.config?.store?.plugin?.serverStats || {};
        if (conf.style) {
            this.styleConfig = { ...this.styleConfig, ...conf.style };
        }
        // 加载自定义指标配置
        this.applyMetricScope(this.resolveSession());
        if (!this.canDisplay(this.resolveSession())) {
            this.visible = false;
            this.synchronizeSession(null);
        }
        this.cdr.detectChanges();
    }

    forceUpdate() { this.checkAndFetch() }

    async checkAndFetch() {
        if (this.destroyed || this.useExternalController) {
            return;
        }

        const isEnabled = this.config?.store?.plugin?.serverStats?.enabled;
        const displayMode = this.config?.store?.plugin?.serverStats?.displayMode || 'bottomBar';
        
        if (displayMode !== 'bottomBar') {
            if (this.visible) {
                this.visible = false;
                this.loading = true;
                this.cdr.detectChanges();
            }
            return;
        }

        const session = this.resolveSession();
        this.synchronizeSession(session);

        if (!isEnabled || !session || session.open === false) {
            if (this.visible) {
                this.visible = false;
                this.loading = true;
                this.cdr.detectChanges();
            }
            return;
        }

        if (session && this.statsService.isPlatformSupport(session)) {
            if (!this.visible) {
                this.visible = true;
                this.loading = true;
                this.cdr.detectChanges();
            }
            
            this.cdr.detectChanges();
            const revision = this.viewRevision;
            try {
                const data = await this.statsService.fetchStats(session)
                if (!this.isCurrentRequest(session, revision)) return;
                this.loading = false;
                if (data) {
                    this.updateStats(data);
                    this.currentStats = data;
                }
                this.cdr.detectChanges();
            } catch (e) {
                if (!this.isCurrentRequest(session, revision)) return;
                this.loading = false;
                this.cdr.detectChanges();
            }
        } else {
            if (this.visible) {
                this.visible = false;
                this.loading = true;
                this.cdr.detectChanges();
            }
        }
    }

    updateStats(stats: { cpu: number, mem: number, disk: number, netRx: number, netTx: number }) {
        this.currentStats = stats
    }

    ngOnDestroy() {
        this.destroyed = true;
        this.viewRevision++;
        this.visible = false;
        this.displaySession = null;
        if (this.timerId) clearInterval(this.timerId)
        if (this.tabSubscription) this.tabSubscription.unsubscribe()
        this.configSubscriptions.forEach(sub => sub.unsubscribe())
    }
}
