import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone, HostListener, ViewChild, ElementRef } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { Subscription } from 'rxjs'
import { AppService, ConfigService } from 'tabby-core'
import { StatsService } from '../services/stats.service'
import { CustomMetric, CustomMetricGroup } from '../config'
import { BuiltinMetricKey } from '../builtin-metrics'
import { PaneGroupMode } from '../services/metric-scope.service'

@Component({
    selector: 'server-stats-bottom-bar',
    template: `
      <ng-container *ngIf="visible">
        <button #paneToggle type="button" class="pane-status-toggle" [class.is-collapsed]="!paneVisible"
            data-testid="pane-status-toggle" (click)="togglePaneMenu($event)" (keydown)="onToggleKeydown($event)"
            (mousemove)="$event.stopPropagation()"
            [attr.aria-expanded]="menuOpen" aria-haspopup="menu"
            [attr.aria-label]="'Pane status bar options' | translate">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12h5l3-8 4 16 3-8h5"></path></svg>
        </button>
        <div #paneMenu *ngIf="menuOpen" class="pane-status-menu" role="menu"
            [style.left.px]="menuPosition.left" [style.top.px]="menuPosition.top"
            [attr.aria-label]="'Pane status bar options' | translate" (keydown)="onMenuKeydown($event)"
            (mousemove)="$event.stopPropagation()" (click)="$event.stopPropagation()">
            <div role="group">
                <button type="button" class="pane-menu-show" role="menuitemradio" [attr.aria-checked]="paneVisible"
                    (click)="setPaneVisibility(true)"><span aria-hidden="true">{{paneVisible ? '✓' : ''}}</span>{{'Show' | translate}}</button>
                <button type="button" class="pane-menu-hide" role="menuitemradio" [attr.aria-checked]="!paneVisible"
                    (click)="setPaneVisibility(false)"><span aria-hidden="true">{{!paneVisible ? '✓' : ''}}</span>{{'Hide' | translate}}</button>
            </div>
            <div class="pane-menu-separator" role="separator"></div>
            <div role="group">
                <button type="button" class="pane-menu-overview" role="menuitemradio" [attr.aria-checked]="paneGroupMode === 'overview'"
                    (click)="setPaneGroupMode('overview')"><span aria-hidden="true">{{paneGroupMode === 'overview' ? '✓' : ''}}</span>{{'Overview' | translate}}</button>
                <button type="button" class="pane-menu-carousel" role="menuitemradio" [attr.aria-checked]="paneGroupMode === 'carousel'"
                    (click)="setPaneGroupMode('carousel')"><span aria-hidden="true">{{paneGroupMode === 'carousel' ? '✓' : ''}}</span>{{'Carousel' | translate}}</button>
                <button type="button" class="pane-menu-static" role="menuitemradio" [attr.aria-checked]="paneGroupMode === 'static'"
                    (click)="setPaneGroupMode('static')"><span aria-hidden="true">{{paneGroupMode === 'static' ? '✓' : ''}}</span>{{'Static' | translate}}</button>
            </div>
        </div>
        <div class="stats-container" 
             *ngIf="paneVisible"
             [style.background]="styleConfig.background">
            <div class="stat-section" *ngIf="loading">
                <div class="loading-text">Loading...</div>
            </div>
            
            <server-stats-metric-strip *ngIf="!loading" [metrics]="customMetrics" [groups]="metricGroups"
                [builtinOrder]="builtinOrder"
                [stats]="currentStats" [session]="displaySession"></server-stats-metric-strip>
        </div>
      </ng-container>
    `,
    styles: [`
        :host { display: block; width: 100%; position: relative; box-sizing: border-box; }
        .stats-container {
            position: relative;
            width: 100%;
            box-sizing: border-box;
            backdrop-filter: blur(8px);
            padding: 1px 12px 1px 29px;
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
        .pane-status-toggle {
            position: absolute; left: 4px; bottom: 1px; z-index: 5;
            display: inline-flex; align-items: center; justify-content: center;
            width: 20px; height: 20px; padding: 2px; margin: 0;
            border: 1px solid rgba(130,170,210,0.6); border-radius: 3px;
            color: #8fcaff; background: rgba(20,24,30,0.92); cursor: pointer;
        }
        .pane-status-toggle svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linejoin: round; stroke-linecap: round; }
        .pane-status-toggle.is-collapsed { color: #b8c4d0; bottom: 2px; }
        .pane-status-toggle:hover { color: #fff; border-color: #8fcaff; }
        .pane-status-toggle:focus-visible { outline: 2px solid #8fcaff; outline-offset: 1px; }
        .pane-status-menu {
            position: fixed; z-index: 10000; max-height: calc(100vh - 16px); overflow-y: auto;
            min-width: 155px; padding: 5px; border: 1px solid #8199b2; border-radius: 6px;
            background: #202831; color: #f0f4f8; box-shadow: 0 4px 18px #0009; font-size: 13px;
        }
        .pane-status-menu button {
            display: flex; align-items: center; width: 100%; gap: 8px; padding: 6px 10px;
            border: none; border-radius: 3px; background: transparent; color: inherit; text-align: left; cursor: pointer;
        }
        .pane-status-menu button span { display: inline-block; width: 14px; color: #8fcaff; }
        .pane-status-menu button:hover, .pane-status-menu button:focus-visible { background: #36506b; outline: 1px solid #8fcaff; }
        .pane-menu-separator { border-top: 1px solid #65788d; margin: 4px 5px; }
    `]
})
export class ServerStatsBottomBarComponent implements OnInit, OnDestroy {
    visible = false
    paneVisible = true
    menuOpen = false
    menuPosition = { left: 4, top: 4 }
    paneGroupMode: PaneGroupMode | undefined
    @ViewChild('paneToggle') private paneToggle?: ElementRef<HTMLButtonElement>
    @ViewChild('paneMenu') private paneMenu?: ElementRef<HTMLElement>
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
        const paneVisible = !session || this.statsService.isPaneVisible?.(session) !== false;
        if (this.paneVisible !== paneVisible) {
            this.viewRevision++;
            this.paneVisible = paneVisible;
        }
        this.applyMetricScope(session);
        if (this.displaySession === session) return;
        this.menuOpen = false;
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
        this.paneGroupMode = session ? this.statsService.getPaneGroupMode?.(session) : undefined;
        // A pane preference is a presentation override, never a change to shared definitions.
        this.metricGroups = this.paneGroupMode ? (visible.metricGroups || []).map(group => ({
            ...group, mode: this.paneGroupMode!, layout: group.layout || 'vertical',
        })) : visible.metricGroups || [];
    }

    private canDisplay(session: any): boolean {
        const conf = this.config?.store?.plugin?.serverStats;
        return !this.destroyed && !!conf?.enabled &&
            !!session && session.open !== false && this.resolveSession() === session;
    }

    private isCurrentRequest(session: any, revision: number): boolean {
        return this.viewRevision === revision && this.displaySession === session && this.canDisplay(session) &&
            this.paneVisible && this.statsService.isPaneVisible?.(session) !== false;
    }

    togglePaneVisibility() {
        const session = this.resolveSession();
        if (!this.canDisplay(session)) return;
        this.setPaneVisibility(this.statsService.isPaneVisible(session) === false);
    }

    setPaneVisibility(visible: boolean) {
        const session = this.resolveSession();
        if (!this.canDisplay(session)) return;
        this.viewRevision++;
        this.statsService.setPaneVisible(session, visible);
        this.synchronizeSession(session);
        this.visible = true;
        if (!this.paneVisible) this.loading = false;
        this.closePaneMenu(true);
        this.cdr.detectChanges();
        // The saved preference emits changed$, which refreshes both controller
        // types. Starting another request here would race the saved revision.
    }

    setPaneGroupMode(mode: PaneGroupMode) {
        const session = this.resolveSession();
        if (!this.canDisplay(session)) return;
        this.statsService.setPaneGroupMode(session, mode);
        // Choosing a presentation mode also resumes a hidden pane's status bar.
        if (this.statsService.isPaneVisible(session) === false) {
            this.setPaneVisibility(true);
        } else {
            this.applyMetricScope(session);
            this.closePaneMenu(true);
            this.cdr.detectChanges();
        }
    }

    togglePaneMenu(event?: Event) {
        event?.stopPropagation();
        if (!this.canDisplay(this.resolveSession())) return;
        this.menuOpen = !this.menuOpen;
        this.cdr.detectChanges();
        if (this.menuOpen) {
            this.positionPaneMenu();
            this.cdr.detectChanges();
            this.menuButtons()[0]?.focus();
        }
    }

    private positionPaneMenu() {
        const toggle = this.paneToggle?.nativeElement.getBoundingClientRect?.();
        const menu = this.paneMenu?.nativeElement.getBoundingClientRect?.();
        if (!toggle || !menu) return;
        this.menuPosition = {
            left: Math.max(8, Math.min(toggle.left, window.innerWidth - menu.width - 8)),
            top: Math.max(8, Math.min(toggle.top - menu.height - 4, window.innerHeight - menu.height - 8)),
        };
    }

    private menuButtons(): HTMLButtonElement[] {
        return Array.from(this.paneMenu?.nativeElement.querySelectorAll<HTMLButtonElement>('button') || []);
    }

    private closePaneMenu(restoreFocus = false) {
        if (!this.menuOpen) return;
        this.menuOpen = false;
        if (restoreFocus && !this.destroyed) this.paneToggle?.nativeElement.focus();
    }

    onToggleKeydown(event: KeyboardEvent) {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault(); event.stopPropagation();
        if (!this.menuOpen) this.togglePaneMenu();
        const buttons = this.menuButtons();
        buttons[event.key === 'ArrowUp' ? buttons.length - 1 : 0]?.focus();
    }

    onMenuKeydown(event: KeyboardEvent) {
        if (!this.menuOpen || this.destroyed) return;
        if (event.key === 'Tab') { this.closePaneMenu(); return; }
        const buttons = this.menuButtons();
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        let next: number;
        if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
        else if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault(); event.stopPropagation();
        buttons[next]?.focus();
    }

    @HostListener('document:keydown', ['$event'])
    onDocumentKeydown(event: KeyboardEvent) {
        if (!this.menuOpen || this.destroyed || event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        this.closePaneMenu(true);
        this.cdr.detectChanges();
    }

    // Tabby's focus-follows-mouse can focus the terminal while the pointer crosses
    // the gap above the toggle. Only an intentional outside click dismisses this menu.
    @HostListener('document:pointerdown', ['$event'])
    onOutsideInteraction(event: Event) {
        if (!this.menuOpen || this.destroyed) return;
        const target = event.target as Node;
        if (this.paneMenu?.nativeElement.contains(target) || this.paneToggle?.nativeElement.contains(target)) return;
        this.closePaneMenu();
        this.cdr.detectChanges();
    }

    @HostListener('window:resize')
    onViewportResize() {
        if (!this.menuOpen || this.destroyed) return;
        this.positionPaneMenu();
        this.cdr.detectChanges();
    }

    renderExternalStats(stats: any | null) {
        if (!this.canDisplay(this.boundSession)) return;
        this.synchronizeSession(this.boundSession);
        this.visible = true;
        if (!this.paneVisible) { this.loading = false; this.cdr.detectChanges(); return; }
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
        this.loading = this.paneVisible && isLoading;
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
        this.configSubscriptions.push(this.config.changed$.subscribe(() => {
            this.loadConfig(true);
            // Per-pane controllers schedule their own refresh; standalone bars
            // must also refresh on save instead of waiting for the next timer.
            if (!this.useExternalController) void this.checkAndFetch();
        }));

        this.configSubscriptions.push(this.statsService.statsUpdated$.subscribe(event => {
            if (this.destroyed) return;
            const session = this.resolveSession();
            this.synchronizeSession(session);
            if (!this.canDisplay(session)) { this.hideExternal(); return; }
            if (!this.paneVisible) { this.loading = false; this.cdr.detectChanges(); return; }
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

    loadConfig(invalidateReadings = false) {
        if (this.destroyed) return;
        this.viewRevision++;
        const conf = this.config?.store?.plugin?.serverStats || {};
        if (conf.style) {
            this.styleConfig = { ...this.styleConfig, ...conf.style };
        }
        // 加载自定义指标配置
        const session = this.resolveSession();
        this.synchronizeSession(session);
        this.visible = this.canDisplay(session);
        if (invalidateReadings) {
            // Stable metric IDs may now refer to different commands or targets.
            // Never show a previous value under a newly saved label or binding.
            this.currentStats = { cpu: 0, mem: 0, disk: 0, netRx: 0, netTx: 0, custom: [] };
            this.loading = this.visible && this.paneVisible;
        }
        if (!this.visible) {
            this.visible = false;
            this.menuOpen = false;
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
            if (!this.paneVisible) {
                this.visible = true;
                this.loading = false;
                this.cdr.detectChanges();
                return;
            }
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
        this.menuOpen = false;
        this.viewRevision++;
        this.visible = false;
        this.displaySession = null;
        if (this.timerId) clearInterval(this.timerId)
        if (this.tabSubscription) this.tabSubscription.unsubscribe()
        this.configSubscriptions.forEach(sub => sub.unsubscribe())
    }
}
