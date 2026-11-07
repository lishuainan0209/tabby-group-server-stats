import { Injectable, Pipe, PipeTransform, Directive, ElementRef, Input, AfterViewChecked } from '@angular/core'
import { Subject } from 'rxjs'
import { TRANSLATIONS } from '../../src/translations'
import { HostConfigProxy } from '../helpers/host-config'
export class ConfigProvider {}
export class SettingsTabProvider {}
@Injectable() export class ConfigService {
    store: any = { language: 'en', plugin: { serverStats: { customMetrics: [], metricGroups: [], defaultInterval: 3, style: {}, defaultMetrics: {} } } }
    raw: any
    private defaults: any
    useHostConfig(defaults: any) {
        this.defaults = { language: 'en', profiles: [], ...defaults }
        this.reloadFromRaw({ language: 'en' })
    }
    reloadFromRaw(raw: any) {
        this.raw = raw
        this.store = new HostConfigProxy(this.raw, this.defaults)
    }
    changed$ = new Subject<void>()
    ready$ = new Subject<void>()
    save() { this.changed$.next() }
}
@Injectable() export class AppService { activeTab: any = null; activeTabChange = new Subject<void>() }
@Injectable() export class PlatformService { openExternal() {} openPath(path: string) { (window as any).openedTutorial = path } }
@Injectable() export class TranslateService { instant(value: string) { return translate(value) } }
const translate = (value: string) => {
    const harness = (window as any).harness
    const locale = harness?.previewChinese ? 'zh-CN' : harness?.config?.store?.language || 'en'
    const dictionary = TRANSLATIONS[locale] || TRANSLATIONS[String(locale).split('-')[0]] || TRANSLATIONS.en || {}
    return dictionary[value] || value
}
@Pipe({ name: 'translate', pure: false }) export class TranslatePipe implements PipeTransform { transform(value: string) { return translate(value) } }
@Directive({ selector: '[translate]' }) export class TranslateDirective implements AfterViewChecked {
    @Input() translate = ''
    private original = ''
    constructor(private element: ElementRef<HTMLElement>) {}
    ngAfterViewChecked() {
        const node = this.element.nativeElement
        if (node.children.length) return
        this.original ||= this.translate || node.textContent?.trim() || ''
        const value = translate(this.original)
        if (node.textContent?.trim() !== value) node.textContent = value
    }
}
