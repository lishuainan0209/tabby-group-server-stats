import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone, HostListener, ViewChild, ElementRef } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { Subscription } from 'rxjs'
import { AppService, ConfigService } from 'tabby-core'
import { StatsService } from '../services/stats.service'
import { CustomMetric, CustomMetricGroup } from '../config'
import { BuiltinMetricKey } from '../builtin-metrics'

@Component({
    selector: 'server-stats-floating-panel',
    template: `
        <div #panel class="stats-container"
             *ngIf="visible"
             (mousedown)="startDrag($event)"
             [style.top.px]="pos.y" 
             [style.left.px]="pos.x" 
             [style.background]="styleConfig.background"
             [style.flex-direction]="styleConfig.layout === 'vertical' ? 'column' : 'row'">
            
            <server-stats-metric-strip [metrics]="customMetrics" [groups]="metricGroups"
                [builtinOrder]="builtinOrder"
                [stats]="currentStats" [session]="metricSession"
                [style.flex-direction]="styleConfig.layout === 'vertical' ? 'column' : 'row'"
                (mousedown)="$event.stopPropagation()"></server-stats-metric-strip>
        </div>
    `,
    styles: [`
        :host { display: block; position: absolute; z-index: 99999; }
        .stats-container {
            position: fixed;
            top: 100px; 
            right: 20px; 
            z-index: 10000; 
            backdrop-filter: blur(12px);
            padding: 10px 14px;
            display: flex; 
            gap: 15px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.2);
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            min-width: 100px;
            max-width: calc(100vw - 20px);
            box-sizing: border-box;
            color: white;
            cursor: move;
            user-select: none;
        }
    `]
})
export class ServerStatsFloatingPanelComponent implements OnInit, OnDestroy {
    @ViewChild('panel') panel?: ElementRef<HTMLElement>
    visible = false
    currentStats: any = { cpu: 0, mem: 0, disk: 0, netRx: 0, netTx: 0, custom: [] }
    
    customMetrics: CustomMetric[] = []
    metricGroups: CustomMetricGroup[] = []
    builtinOrder: BuiltinMetricKey[] = []

    private isDragging = false
    private dragOffset = { x: 0, y: 0 }
    private dragDimensions = { width: 0, height: 0 }
    public pos = { x: null as number | null, y: null as number | null }
    public styleConfig = { background: 'rgba(20, 20, 20, 0.90)', size: 100, layout: 'vertical' }
    private timerId: any = null
    private tabSubscription: Subscription | null = null
    private destroyed = false
    private displaySession: any = null
    private viewRevision = 0
    constructor(
        private statsService: StatsService,
        private config: ConfigService,
        private app: AppService,
        private cdr: ChangeDetectorRef,
        private zone: NgZone,
        private sanitizer: DomSanitizer
    ) {
        (window as any).serverStatsFloating = this;
    }

    private subscriptions: Subscription[] = []

    ngOnInit() {
        this.loadConfig();
        this.subscriptions.push(this.config.ready$.subscribe(() => {
            this.loadConfig();
            setTimeout(() => this.checkAndFetch(), 100);
        }));
        this.subscriptions.push(this.config.changed$.subscribe(() => this.loadConfig()));

        this.subscriptions.push(this.statsService.statsUpdated$.subscribe(event => {
            if (this.destroyed) return;
            const session = this.activeSession();
            this.synchronizeSession(session);
            if (!this.canDisplay(session)) { this.hide(); return; }
            if (this.statsService.getServerKey(session) === event.serverKey) {
                this.visible = true;
                this.updateCharts(event.stats);
                this.cdr.detectChanges();
            } else {
                this.cdr.detectChanges();
            }
        }));

        if ((this.app as any).activeTabChange) {
            this.tabSubscription = (this.app as any).activeTabChange.subscribe(() => {
                this.checkAndFetch();
            });
        }

        setTimeout(() => this.checkAndFetch(), 100);

        this.zone.runOutsideAngular(() => {
            this.timerId = window.setInterval(() => {
                this.zone.run(() => {
                    this.checkAndFetch()
                })
            }, 1000)
        })
    }

    loadConfig() {
        if (this.destroyed) return;
        this.viewRevision++;
        const conf = this.config?.store?.plugin?.serverStats || {};
        if (conf.location) {
            this.pos = { x: conf.location.x, y: conf.location.y };
        } else {
            this.pos = { x: null, y: null };
        }
        if (conf.style) {
            this.styleConfig = { ...this.styleConfig, ...conf.style };
        }

        // 加载自定义指标
        this.applyMetricScope(this.activeSession());
        if (!this.canDisplay(this.activeSession())) this.hide();

        setTimeout(() => this.adjustPositionToViewport(), 100);
        this.cdr.detectChanges();
    }

    startDrag(event: MouseEvent) {
        if (event.button !== 0) return; 
        this.isDragging = true;
        const target = event.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        this.dragDimensions.width = rect.width;
        this.dragDimensions.height = rect.height;
        this.dragOffset.x = event.clientX - rect.left;
        this.dragOffset.y = event.clientY - rect.top;
        event.preventDefault(); 
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove(event: MouseEvent) {
        if (!this.isDragging) return;
        let newX = event.clientX - this.dragOffset.x;
        let newY = event.clientY - this.dragOffset.y;
        const maxX = window.innerWidth - this.dragDimensions.width;
        const maxY = window.innerHeight - this.dragDimensions.height;
        this.pos.x = Math.min(Math.max(0, newX), maxX);
        this.pos.y = Math.min(Math.max(0, newY), maxY);
    }

    @HostListener('document:mouseup')
    onMouseUp() {
        if (this.isDragging) {
            this.isDragging = false;
            this.adjustPositionToViewport();
            if (!this.config.store.plugin.serverStats) {
                this.config.store.plugin.serverStats = {};
            }
            if (!this.config.store.plugin.serverStats.location) {
                this.config.store.plugin.serverStats.location = {};
            }
            this.config.store.plugin.serverStats.location.x = this.pos.x;
            this.config.store.plugin.serverStats.location.y = this.pos.y;
            this.config.save();
        }
    }

    private adjustPositionToViewport() {
        if (this.destroyed) return;
        if (this.pos.x === null || this.pos.y === null) return
        const rect = this.panel?.nativeElement.getBoundingClientRect() || { width: 240, height: 100 }
        const padding = 10
        const maxX = Math.max(padding, window.innerWidth - rect.width - padding)
        const maxY = Math.max(padding, window.innerHeight - rect.height - padding)
        let x = this.pos.x
        let y = this.pos.y
        if (x < padding) x = padding
        if (x > maxX) x = maxX
        if (y < padding) y = padding
        if (y > maxY) y = maxY
        if (x !== this.pos.x || y !== this.pos.y) {
            this.pos.x = x
            this.pos.y = y
            this.cdr.detectChanges()
        }
    }

    @HostListener('window:resize')
    onWindowResize() {
        this.adjustPositionToViewport();
    }

    forceUpdate() { this.checkAndFetch() }

    async checkAndFetch() {
        if (this.destroyed) return;
        const session = this.activeSession();
        this.synchronizeSession(session);
        const isEnabled = this.config?.store?.plugin?.serverStats?.enabled;
        const displayMode = this.config?.store?.plugin?.serverStats?.displayMode || 'bottomBar';
        if (displayMode !== 'floatingPanel') {
            this.hide();
            return;
        }
        let activeTab: any = this.app.activeTab
        if (!isEnabled || !activeTab) {
            this.hide();
            return;
        }
        if (activeTab['focusedTab']) {
            activeTab = activeTab['focusedTab'];
        }
        if (activeTab['frontendIsReady'] === false || !activeTab['frontend']) {
            this.hide();
            return;
        }
        this.cdr.detectChanges();
        const revision = this.viewRevision;
        if (session && session.open !== false && this.statsService.isPlatformSupport(session)) {
            try {
                const data = await this.statsService.fetchStats(session)
                if (!this.isCurrentRequest(session, revision)) return;
                if (data) {
                    this.visible = true; 
                    this.updateCharts(data);
                    this.cdr.detectChanges();
                    return;
                }
            } catch (e) {}
        }
        if (this.isCurrentRequest(session, revision)) this.hide();
    }

    hoveredCustom: string | null = null
    private activeSession(): any {
        let tab: any = this.app.activeTab
        if (tab?.focusedTab) tab = tab.focusedTab
        return tab?.session || null
    }
    get metricSession(): any { return this.displaySession }

    private canDisplay(session: any): boolean {
        const conf = this.config?.store?.plugin?.serverStats;
        let tab: any = this.app.activeTab;
        if (tab?.focusedTab) tab = tab.focusedTab;
        return !this.destroyed && !!conf?.enabled && conf.displayMode === 'floatingPanel' &&
            !!session && session.open !== false && tab?.session === session &&
            tab.frontendIsReady !== false && !!tab.frontend;
    }

    private synchronizeSession(session: any) {
        this.applyMetricScope(session);
        if (this.displaySession === session) return;
        this.viewRevision++;
        this.displaySession = session;
        this.hoveredCustom = null;
        this.visible = false;
        const cached = session?.open !== false && session ? this.statsService.getCachedStats(session) : null;
        this.updateCharts(cached || { cpu: 0, mem: 0, disk: 0, netRx: 0, netTx: 0, custom: [] });
        this.visible = !!cached && this.canDisplay(session);
    }

    private applyMetricScope(session: any) {
        const conf = this.config?.store?.plugin?.serverStats || {};
        const visible = this.statsService.getVisibleConfig?.(session) || conf;
        this.builtinOrder = conf.builtinOrder || [];
        const metrics = visible.customMetrics || [];
        const changed = this.customMetrics.map(metric => metric.id).join('|') !== metrics.map(metric => metric.id).join('|');
        this.customMetrics = metrics;
        this.metricGroups = visible.metricGroups || [];
        if (changed) {
            this.hoveredCustom = null;
        }
    }

    private isCurrentRequest(session: any, revision: number): boolean {
        return this.viewRevision === revision && this.displaySession === session && this.canDisplay(session);
    }

    private hide() {
        if (this.destroyed) return;
        this.viewRevision++;
        this.synchronizeSession(null);
        this.visible = false;
        this.hoveredCustom = null;
        this.cdr.detectChanges();
    }
    updateCharts(stats: any) { this.currentStats = stats }

    ngOnDestroy() {
        this.destroyed = true;
        this.viewRevision++;
        this.displaySession = null;
        this.hoveredCustom = null;
        this.visible = false;
        if (this.timerId) clearInterval(this.timerId)
        if (this.tabSubscription) this.tabSubscription.unsubscribe()
        this.subscriptions.forEach(sub => sub.unsubscribe())
    }
}
