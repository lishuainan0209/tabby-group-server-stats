import { Component, Input, OnChanges, OnDestroy, OnInit, AfterViewChecked, ViewChild, ViewChildren, QueryList, ElementRef, ChangeDetectorRef, NgZone, HostListener } from '@angular/core'
import { DomSanitizer, SafeUrl } from '@angular/platform-browser'
import { CustomMetric, CustomMetricGroup, evaluateColor, formatFontAwesomeIcon, getSvgPresetPath, isFaIcon, isUrlOrDataUri } from '../config'
import { StatsService } from '../services/stats.service'
import { carouselChildren, nextCarouselId, metricStatus, metricIsVisible, visibleGroupMetrics, parseNetworkDetail, parseNumericRatio, formatNetworkRate, isNumericDisplayValue, DisplayResult } from '../metric-display'
import { BuiltinMetricKey, OrderedMetricItem, orderBuiltinItems } from '../builtin-metrics'
import { METRIC_COLORS } from '../metric-colors'

@Component({
    selector: 'server-stats-metric-strip',
    template: `
      <ng-template #value let-metric let-expanded="expanded">
        <span class="metric-label" [attr.title]="metric.label | translate">
          <svg *ngIf="svgPath(metric.icon)" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="svgPath(metric.icon)"></path></svg>
          <img *ngIf="isUrl(metric.icon)" [src]="iconUrl(metric.icon)" alt="">
          <i *ngIf="isFa(metric.icon)" [class]="iconClass(metric.icon)" aria-hidden="true"></i>
          <span>{{metric.label | translate}}</span>
        </span>
        <span class="metric-reading">
          <span class="meter" *ngIf="metric.type === 'progress' && status(metric) === 'ok'">
            <span [style.width.%]="progress(metric)" [style.background]="color(metric)"></span>
          </span>
          <span class="metric-value" [style.color]="color(metric)">{{status(metric) === 'unavailable' ? (result(metric).value | translate) : displayValue(metric)}}<span *ngIf="status(metric) === 'ok'">{{suffix(metric)}}</span></span>
        </span>
        <span class="metric-detail" *ngIf="expanded && metric.detailCommand && status(metric) === 'ok'"
              [class.detail-error]="detailError(metric)" [style.color]="detailError(metric) ? colors.red : color(metric)"
              [attr.title]="detailError(metric) ? details[metric.id] : networkDetail(metric) ? (('Since interface creation or counter reset' | translate) + ' · ' + networkDetail(metric).interfaces) : null">
            <span class="network-detail" *ngIf="networkDetail(metric) as network; else ordinaryDetail"><span>{{network.label | translate}} </span><span class="network-amount">{{network.amount}}</span><span class="network-unit"> GiB</span></span>
            <ng-template #ordinaryDetail>
              <span class="numeric-ratio" *ngIf="detailRatio(metric) as ratio; else plainDetail"><span class="ratio-numerator">{{ratio.numerator}}</span><span class="ratio-slash">/</span><span class="ratio-denominator">{{ratio.denominator}}</span><span class="ratio-unit">{{ratio.suffix ? ' ' + ratio.suffix : ''}}</span></span>
              <ng-template #plainDetail>{{detailText(metric) | translate}}{{detailExitCode(metric)}}</ng-template>
            </ng-template>
        </span>
      </ng-template>

      <ng-container *ngFor="let item of visibleItems; trackBy: trackId">
      <div *ngIf="item.metric as metric" class="single metric-row" tabindex="0"
           (mouseenter)="enterMetric(metric)" (mouseleave)="leaveMetric(metric)"
           (focusin)="enterMetric(metric)" (focusout)="leaveMetric(metric)"
           [attr.aria-label]="(metric.label || metric.id) | translate">
        <ng-container *ngTemplateOutlet="value; context: { $implicit: metric, expanded: hoveredMetric === metric.id || autoDetailMetric === metric.id }"></ng-container>
      </div>

      <div *ngIf="item.group as group" class="metric-group" tabindex="0"
           [style.--ratio-left-width]="ratioColumnWidth(group, 'numerator')" [style.--ratio-right-width]="ratioColumnWidth(group, 'denominator')"
           [style.--ratio-unit-width]="ratioUnitWidth(group)"
           [style.--detail-amount-width]="networkAmountWidth(group)"
           [class.vertical]="group.mode === 'static' && group.layout === 'vertical'"
           (mouseenter)="enterGroup(group, $event)" (mouseleave)="leaveGroup(group)"
           (focusin)="enterGroup(group, $event)" (focusout)="blurGroup(group, $event)"
           [attr.aria-label]="(group.label || 'Metric group') | translate"
           [attr.aria-expanded]="group.mode !== 'static' ? hoveredGroup === group.id : null">
        <ng-container *ngIf="group.mode === 'static'">
          <div *ngFor="let metric of allMetrics(group); trackBy: trackId" class="metric-row" tabindex="0" [class.child-row]="metric.id !== group.main?.id"
               (mouseenter)="enterChild(group, metric)" (mouseleave)="leaveMetric(metric)"
               (focusin)="enterChild(group, metric)" (focusout)="leaveMetric(metric)">
            <ng-container *ngTemplateOutlet="value; context: { $implicit: metric, expanded: expanded(group, metric) }"></ng-container>
          </div>
        </ng-container>
        <ng-container *ngIf="group.mode !== 'static'">
          <div #carouselSlot class="collapsed-slot" [class.carousel-slot]="group.mode === 'carousel'" [attr.data-carousel-group]="group.mode === 'carousel' ? group.id : null">
            <div class="carousel-measures" *ngIf="group.mode === 'carousel'" aria-hidden="true">
              <div class="carousel-measure metric-row" aria-hidden="true" *ngFor="let candidate of carouselCandidates(group); trackBy: trackId">
                <ng-container *ngTemplateOutlet="value; context: { $implicit: candidate, expanded: false }"></ng-container>
              </div>
            </div>
            <div class="metric-row collapsed-row" [class.carousel-active]="group.mode === 'carousel'" *ngIf="collapsedMetric(group) as metric; else empty">
              <ng-container *ngTemplateOutlet="value; context: { $implicit: metric, expanded: false }"></ng-container>
            </div>
            <ng-template #empty><span class="empty">{{group.emptyText || ('No available items' | translate)}}</span></ng-template>
          </div>
          <span class="expand-hint" aria-hidden="true">▴</span>
          <div *ngIf="hoveredGroup === group.id" #groupPopup class="group-details" role="region"
               [style.--ratio-left-width]="ratioColumnWidth(group, 'numerator')" [style.--ratio-right-width]="ratioColumnWidth(group, 'denominator')"
               [style.--ratio-unit-width]="ratioUnitWidth(group)"
               [style.--detail-amount-width]="networkAmountWidth(group)"
               [style.left.px]="popup.left" [style.top.px]="popup.top" [style.max-height.px]="popup.maxHeight"
               [style.max-width.px]="popup.width" (mouseenter)="keepGroup(group)" (mouseleave)="leaveGroup(group)">
            <div class="details-title">{{(group.label || 'Metric group') | translate}}</div>
            <div class="detail-grid">
              <div *ngFor="let metric of allMetrics(group); trackBy: trackId" class="metric-row detail-row" [class.child-row]="metric.id !== group.main?.id">
                <ng-container *ngTemplateOutlet="value; context: { $implicit: metric, expanded: true }"></ng-container>
              </div>
            </div>
          </div>
        </ng-container>
      </div>
      </ng-container>
    `,
    styles: [`
      :host { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-width: 0; font-size: 11px; color: #ddd; }
      .single, .metric-group { border-right: 1px solid #ffffff40; padding-right: 6px; }
      .metric-row { display: inline-flex; align-items: center; gap: 6px; min-height: 18px; max-width: 100%; }
      .metric-row:focus-visible, .metric-group:focus-visible { outline: 1px solid #5baaff; outline-offset: 3px; }
      .metric-label { display: inline-flex; gap: 4px; align-items: center; color: #bfc5cd; white-space: nowrap; }
      .metric-label svg, .metric-label img { width: 12px; height: 12px; object-fit: contain; fill: currentColor; }
      .metric-value { font: 600 11px monospace; font-variant-numeric: tabular-nums; text-align: right; white-space: pre-wrap; overflow-wrap: anywhere; }
      .metric-detail { font: 11px monospace; font-variant-numeric: tabular-nums; text-align: right; color: #d1d7e0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .numeric-ratio { display: inline-grid; grid-template-columns: var(--ratio-left-width, max-content) 1ch var(--ratio-right-width, max-content) var(--ratio-unit-width, max-content); align-items: baseline; white-space: pre; }
      .ratio-unit { text-align: left; }
      .ratio-numerator, .ratio-denominator, .network-amount { text-align: right; }
      .ratio-slash { text-align: center; }
      .network-detail { display: inline-grid; grid-template-columns: max-content var(--detail-amount-width, max-content) max-content; align-items: baseline; white-space: pre; }
      .metric-detail:not(:empty) { border-left: 1px solid #ffffff40; padding-left: 6px; }
      .metric-reading { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; }
      .meter { display: inline-block; height: 7px; width: 50px; flex: 0 0 50px; overflow: hidden; background: #ffffff26; border-radius: 4px; }
      .meter > span { display: block; height: 100%; transition: width .3s; }
      .metric-group { display: inline-flex; gap: 6px; align-items: center; position: relative; cursor: default; min-width: 0; max-width: 100%; box-sizing: border-box; }
      .metric-group:not(.vertical) > .metric-row + .metric-row { border-left: 1px solid #ffffff40; padding-left: 6px; }
      .collapsed-slot { min-width: 0; }
      .carousel-slot { flex: 0 1 auto; width: var(--carousel-width, max-content); max-width: calc(100vw - 48px); }
      .carousel-measures { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: hidden; visibility: hidden; pointer-events: none; }
      .carousel-measure { position: absolute; visibility: hidden; pointer-events: none; width: max-content; max-width: none; }
      .carousel-measure .metric-value { white-space: pre; }
      .carousel-active { display: flex; flex-wrap: wrap; width: 100%; }
      .carousel-active .metric-label { white-space: normal; overflow-wrap: anywhere; min-width: 0; }
      .carousel-active .metric-reading { min-width: 0; max-width: 100%; }
      .carousel-active .metric-value { min-width: 0; }
      .metric-group.vertical { display: grid; grid-template-columns: max-content max-content minmax(0, max-content); align-items: center; gap: 0 6px; }
      .metric-group.vertical > .metric-row { display: contents; }
      .metric-group.vertical > .metric-row + .metric-row::before { content: ''; grid-column: 1 / -1; height: 1px; background: #ffffff40; }
      .metric-group.vertical .metric-label, .metric-group.vertical .metric-reading, .metric-group.vertical .metric-value, .metric-group.vertical .metric-detail { line-height: 12px; }
      .metric-group.vertical .metric-label { grid-column: 1; }
      .metric-group.vertical .metric-reading { grid-column: 2; }
      .metric-group.vertical .metric-detail { grid-column: 3; }
      .metric-group.vertical .child-row .metric-label { padding-left: 12px; }
      .expand-hint { color: #8493a5; font-size: 9px; }
      .group-details { position: fixed; z-index: 100000; box-sizing: border-box; width: max-content; background: #181c23; border: 1px solid #ffffff32; border-radius: 8px; padding: 10px 12px; box-shadow: 0 5px 24px #0009; overflow: auto; color: #ddd; }
      .details-title { font-size: 15px; font-weight: 600; padding-bottom: 7px; border-bottom: 1px solid #ffffff40; margin-bottom: 7px; }
      .detail-grid { display: grid; grid-template-columns: minmax(0, max-content) max-content minmax(0, max-content); align-items: center; gap: 4px 6px; }
      .detail-row { display: contents; }
      .detail-row .metric-label { grid-column: 1; min-width: 0; font-size: 14px; white-space: normal; overflow-wrap: anywhere; }
      .detail-row.child-row .metric-label { padding-left: 16px; }
      .detail-row .metric-label svg, .detail-row .metric-label img { width: 15px; height: 15px; flex: 0 0 15px; }
      .detail-row .metric-reading { grid-column: 2; }
      .detail-row .metric-value, .detail-row .metric-detail { font-size: 13px; }
      .detail-row .metric-detail { grid-column: 3; min-width: 0; }
      .detail-error { font-weight: 500; }
      .empty { color: #c7a66c; }
    `]
})
export class MetricStripComponent implements OnInit, OnChanges, OnDestroy, AfterViewChecked {
    readonly colors = METRIC_COLORS
    @Input() metrics: CustomMetric[] = []
    @Input() groups: CustomMetricGroup[] = []
    @Input() builtinOrder: BuiltinMetricKey[] = []
    @Input() stats: any = { custom: [] }
    @Input() session: any = null
    @Input() autoDetailMetric: string | null = null
    @ViewChild('groupPopup') groupPopup?: ElementRef<HTMLElement>
    @ViewChildren('carouselSlot') carouselSlots?: QueryList<ElementRef<HTMLElement>>
    private portal: HTMLElement | null = null
    private carouselWidths = new Map<string, { width: number; settled: boolean }>()
    details: Record<string, string> = {}
    hoveredMetric: string | null = null
    hoveredGroup: string | null = null
    popup = { left: 8, top: 8, width: 480, maxHeight: 300 }
    private selections = new Map<string, { id?: string; since: number }>()
    private timer: any
    private closeTimer: any
    private anchor: HTMLElement | null = null
    private generation = 0
    private destroyed = false
    private detailRequest = false
    private lastDetailsAt = 0
    private previousSession: any
    private configSignature = ''

    constructor(private service: StatsService, private cdr: ChangeDetectorRef, private zone: NgZone, private sanitizer: DomSanitizer) {}

    ngAfterViewChecked() {
        this.measureCarousels()
        // Both Tabby panels use backdrop-filter, which creates a containing block
        // for fixed descendants. Keep the live Angular view outside that block.
        const popup = this.groupPopup?.nativeElement || null
        if (this.portal && this.portal !== popup) this.portal.remove()
        if (popup && popup.parentElement !== document.body) document.body.appendChild(popup)
        this.portal = popup
        // Position against its measured content size, rather than reserving a wide
        // fixed panel with estimated row heights. Wrapping remains viewport-safe.
        if (popup && this.anchor) {
            const anchor = this.anchor.getBoundingClientRect()
            const bounds = popup.getBoundingClientRect()
            const above = anchor.top >= Math.min(bounds.height, 140)
            const available = above ? anchor.top - 14 : window.innerHeight - anchor.bottom - 14
            popup.style.maxHeight = `${Math.max(60, Math.min(380, available))}px`
            const actual = popup.getBoundingClientRect()
            popup.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - actual.width - 8))}px`
            popup.style.top = `${above ? Math.max(8, anchor.top - actual.height - 6) : anchor.bottom + 6}px`
        }
    }

    ngOnInit() {
        void this.refreshDetails()
        this.zone.runOutsideAngular(() => {
            this.timer = setInterval(() => this.zone.run(() => {
                if (this.destroyed) return
                if (!this.session || this.session.open === false) { this.closeHover(); return }
                this.updateCarousel(Date.now(), true)
                if (Date.now() - this.lastDetailsAt >= 1000) void this.refreshDetails()
                this.cdr.markForCheck()
            }), 250)
        })
    }

    ngOnChanges() {
        const signature = JSON.stringify([this.metrics, this.groups, this.builtinOrder])
        if (this.previousSession !== this.session || signature !== this.configSignature) {
            this.generation++
            this.details = {}
            this.closeHover()
            this.selections.clear()
            this.carouselWidths.clear()
            this.previousSession = this.session
            this.configSignature = signature
        }
        this.updateCarousel(Date.now(), false)
    }

    private get results(): DisplayResult[] { return this.stats?.custom || [] }
    get visibleMetrics(): CustomMetric[] { return this.metrics.filter(metric => metricIsVisible(metric, this.results)) }
    get visibleGroups(): CustomMetricGroup[] { return this.groups.filter(group => this.allMetrics(group).length > 0) }
    get visibleItems(): OrderedMetricItem[] { return orderBuiltinItems(this.visibleMetrics, this.visibleGroups, this.builtinOrder) }
    trackId(_: number, item: { id: string }) { return item.id }
    allMetrics(group: CustomMetricGroup): CustomMetric[] { return visibleGroupMetrics(group, this.results) }
    carouselCandidates(group: CustomMetricGroup): CustomMetric[] { return carouselChildren(group, this.results) }
    private measureCarousels() {
        for (const ref of this.carouselSlots?.toArray() || []) {
            const slot = ref.nativeElement
            const id = slot.getAttribute('data-carousel-group')
            if (!id) continue
            const group = this.groups.find(item => item.id === id)
            if (!group) continue
            let saved = this.carouselWidths.get(id)
            if (!saved?.settled) {
                const widths = Array.from(slot.querySelectorAll<HTMLElement>('.carousel-measure')).map(row => row.getBoundingClientRect().width)
                const measured = Math.ceil(Math.max(0, ...widths))
                if (!measured) continue
                // Reserve the longest child once the initial values arrive. Future
                // longer values wrap inside this width, so the bar never jumps.
                saved = { width: Math.max(saved?.width || 0, measured), settled: group.children.filter(metric => metric.enabled !== false).every(metric => this.status(metric) !== 'pending') }
                this.carouselWidths.set(id, saved)
            }
            slot.style.setProperty('--carousel-width', `${saved.width}px`)
        }
    }
    result(metric: CustomMetric): DisplayResult { return this.results.find(item => item.id === metric.id) || { id: metric.id, value: '-', status: 'pending' } }
    status(metric: CustomMetric): string { return metricStatus(this.result(metric)) }
    color(metric: CustomMetric): string {
        const status = this.status(metric)
        if (status === 'pending') return '#8a929e'
        if (status === 'error') return METRIC_COLORS.red
        return evaluateColor(this.result(metric).value, metric.colorRules, status === 'unavailable' ? METRIC_COLORS.orange : metric.color || METRIC_COLORS.green)
    }
    progress(metric: CustomMetric): number {
        const number = parseFloat(this.result(metric).value)
        return Number.isFinite(number) ? Math.min(100, Math.max(0, number / (metric.maxValue || 100) * 100)) : 0
    }
    private isNetworkRate(metric: CustomMetric): boolean {
        return metric.suffix?.trim() === 'KiB/s' && this.status(metric) === 'ok' && isNumericDisplayValue(this.result(metric).value)
    }
    displayValue(metric: CustomMetric): string {
        const value = this.result(metric).value
        return this.isNetworkRate(metric) ? formatNetworkRate(value) : value
    }
    suffix(metric: CustomMetric): string {
        const suffix = this.isNetworkRate(metric) ? 'MB/s' : metric.suffix?.trim() || (metric.type === 'progress' ? '%' : '')
        return suffix && !suffix.startsWith('%') ? ' ' + suffix : suffix
    }
    detailRatio(metric: CustomMetric) { return this.detailError(metric) ? null : parseNumericRatio(this.details[metric.id] || '') }
    ratioColumnWidth(group: CustomMetricGroup, column: 'numerator' | 'denominator'): string {
        return `${Math.max(1, ...this.allMetrics(group).map(metric => this.detailRatio(metric)?.[column].length || 0))}ch`
    }
    ratioUnitWidth(group: CustomMetricGroup): string {
        return `${Math.max(0, ...this.allMetrics(group).map(metric => {
            const suffix = this.detailRatio(metric)?.suffix
            return suffix ? suffix.length + 1 : 0
        }))}ch`
    }
    networkAmountWidth(group: CustomMetricGroup): string {
        return `${Math.max(1, ...this.allMetrics(group).map(metric => this.networkDetail(metric)?.amount.length || 0))}ch`
    }
    detailError(metric: CustomMetric): boolean { return (this.details[metric.id] || '').startsWith('Err:') }
    networkDetail(metric: CustomMetric) {
        return /^builtin-net-(main|rx|tx)$/.test(metric.id) ? parseNetworkDetail(this.details[metric.id]) : null
    }
    detailText(metric: CustomMetric): string {
        const value = this.details[metric.id] || ''
        if (!this.detailError(metric)) return value
        if (value === 'Err: No result') return 'No detail received'
        if (value === 'Err: No output') return 'Detail returned no data'
        if (value === 'Err: Incomplete output') return 'Incomplete detail response'
        if (value.startsWith('Err: Remote error')) return 'Remote detail command failed'
        if (value === 'Err: Timeout') return 'Detail command timed out'
        if (value === 'Err: Check timeout') return 'Detail check timed out'
        if (value === 'Err: Connection') return 'Unable to fetch details'
        return 'Detail command failed'
    }
    detailExitCode(metric: CustomMetric): string {
        const match = /^Err: Exit (\d+)$/.exec(this.details[metric.id] || '')
        return match ? ` (${match[1]})` : ''
    }
    svgPath = getSvgPresetPath
    isUrl = isUrlOrDataUri
    isFa = isFaIcon
    iconClass = formatFontAwesomeIcon
    iconUrl(icon: string): SafeUrl | string { return icon?.startsWith('data:image/') ? this.sanitizer.bypassSecurityTrustUrl(icon) : icon }

    collapsedMetric(group: CustomMetricGroup): CustomMetric | undefined {
        if (group.enabled === false) return undefined
        return group.mode === 'overview' ? (metricIsVisible(group.main, this.results) ? group.main : undefined) :
            carouselChildren(group, this.results).find(metric => metric.id === this.selections.get(group.id)?.id)
    }

    private updateCarousel(now: number, advance: boolean) {
        for (const group of this.visibleGroups) {
            if (group.mode !== 'carousel') continue
            let selection = this.selections.get(group.id)
            if (!selection) { selection = { since: now }; this.selections.set(group.id, selection) }
            const eligible = carouselChildren(group, this.results)
            if (!eligible.some(metric => metric.id === selection!.id)) {
                selection.id = nextCarouselId(group, this.results, selection.id)
                selection.since = now
            } else if (this.hoveredGroup === group.id) {
                selection.since = now
            } else if (advance && now - selection.since >= Math.max(1, group.interval || 3) * 1000) {
                selection.id = nextCarouselId(group, this.results, selection.id)
                selection.since = now
            }
        }
    }

    expanded(group: CustomMetricGroup, metric: CustomMetric): boolean {
        return group.layout === 'vertical' ? this.hoveredGroup === group.id : this.hoveredMetric === metric.id
    }
    enterMetric(metric: CustomMetric) { this.hoveredMetric = metric.id; void this.refreshDetails() }
    leaveMetric(metric: CustomMetric) { if (this.hoveredMetric === metric.id) this.hoveredMetric = null }
    enterChild(group: CustomMetricGroup, metric: CustomMetric) {
        if (group.layout !== 'vertical') this.enterMetric(metric)
    }
    enterGroup(group: CustomMetricGroup, event: Event) {
        clearTimeout(this.closeTimer)
        this.hoveredGroup = group.id
        this.anchor = event.currentTarget as HTMLElement
        this.positionPopup()
        void this.refreshDetails()
    }
    keepGroup(group: CustomMetricGroup) { clearTimeout(this.closeTimer); this.hoveredGroup = group.id }
    leaveGroup(group: CustomMetricGroup) {
        this.closeTimer = setTimeout(() => {
            if (this.hoveredGroup === group.id) { this.hoveredGroup = null; this.hoveredMetric = null; this.cdr.markForCheck() }
        }, group.mode === 'static' ? 0 : 100)
    }
    blurGroup(group: CustomMetricGroup, event: FocusEvent) {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) this.leaveGroup(group)
    }
    @HostListener('keydown.escape') closeHover() {
        clearTimeout(this.closeTimer)
        this.hoveredMetric = null
        this.hoveredGroup = null
    }
    @HostListener('window:resize')
    positionPopup() {
        if (!this.anchor) return
        const rect = this.anchor.getBoundingClientRect()
        const width = Math.max(120, Math.min(560, window.innerWidth - 16))
        const group = this.groups.find(item => item.id === this.hoveredGroup)
        const height = Math.min(380, 54 + this.allMetrics(group || { children: [] } as any).length * 38)
        const above = rect.top >= Math.min(height, 140)
        const maxHeight = Math.max(70, above ? rect.top - 12 : window.innerHeight - rect.bottom - 12)
        this.popup = {
            left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
            top: above ? Math.max(8, rect.top - Math.min(height, maxHeight)) : rect.bottom,
            width, maxHeight: Math.min(height, maxHeight)
        }
    }

    private async refreshDetails() {
        if (this.detailRequest || !this.session || this.session.open === false) return
        const group = this.visibleGroups.find(item => item.id === this.hoveredGroup)
        const all = [...this.visibleMetrics, ...this.visibleGroups.reduce((items, item) => items.concat(this.allMetrics(item)), [] as CustomMetric[])]
        const requested = group && (group.mode !== 'static' || group.layout === 'vertical') ? this.allMetrics(group) : all.filter(metric => metric.id === (this.hoveredMetric || this.autoDetailMetric))
        const metrics = requested.filter(metric => metric.detailCommand?.trim())
        if (!metrics.length) return
        this.detailRequest = true
        this.lastDetailsAt = Date.now()
        const generation = this.generation
        try {
            const details = await this.service.fetchDetails(this.session, metrics)
            if (!this.destroyed && generation === this.generation) {
                this.details = { ...this.details, ...details }
                this.cdr.markForCheck()
            }
        } catch {
            // A failed detail request must not replace or hide the primary value.
        } finally { this.detailRequest = false }
    }
    ngOnDestroy() { this.destroyed = true; this.generation++; clearInterval(this.timer); clearTimeout(this.closeTimer); this.portal?.remove() }
}
