import { Injectable } from '@angular/core'
import { Subject } from 'rxjs'
import { filterScopedMetrics } from '../../src/display-scope'
@Injectable() export class StatsService {
    static isDebugEnabled = false
    statsUpdated$ = new Subject<any>()
    isPaneVisible(session: any): boolean { return (window as any).harness.paneVisibility[session?.id] !== false }
    setPaneVisible(session: any, visible: boolean): void {
        const root = (window as any).harness
        root.paneVisibility[session.id] = visible
        root.config.changed$.next()
    }
    getPaneGroupMode(session: any): 'overview' | 'carousel' | 'static' | undefined {
        return (window as any).harness.paneGroupModes[session?.id]
    }
    setPaneGroupMode(session: any, mode: 'overview' | 'carousel' | 'static'): void {
        const root = (window as any).harness
        root.paneGroupModes[session.id] = mode
        root.config.changed$.next()
    }
    async fetchDetails(session: any, metrics: any[]) {
        const root = (window as any).harness
        root.detailCalls.push(metrics.map(metric => metric.id))
        await new Promise(resolve => setTimeout(resolve, root.detailDelay || 0))
        return Object.fromEntries(metrics.map(metric => [metric.id, root.detailResults?.[metric.id] ?? (root.stats.custom.find((r: any) => r.id === metric.id)?.status === 'unavailable' ? '' : '可用 740G / 已用 1.26T')]))
    }
    getServerKey() { return 'demo' }
    getVisibleConfig(session: any) {
        const root = (window as any).harness
        // Exercise the production scope filter while keeping transport data mocked.
        return filterScopedMetrics(root.config.store.plugin.serverStats,
            { profileIds: session?.profile?.id ? [session.profile.id] : [] }, root.config.store.profiles || [])
    }
    getCachedStats() { return null }
    isPlatformSupport() { return true }
    async fetchStats() { return (window as any).harness.stats }
}
