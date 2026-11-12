import { Injectable } from '@angular/core'
import { Subject } from 'rxjs'
import { filterScopedMetrics } from '../../src/display-scope'
@Injectable() export class StatsService {
    static isDebugEnabled = false
    getPaneAlignment(session: any): string { return (window as any).harness.config.store.plugin.serverStats.paneAlignments?.[session.id] || 'top' }
    setPaneAlignment(session: any, alignment: string): void {
        const root = (window as any).harness
        const conf = root.config.store.plugin.serverStats
        conf.paneAlignments = { ...conf.paneAlignments, [session.id]: alignment }
        root.config.changed$.next()
    }
    getPaneIconCorner(session: any): string { return (window as any).harness.config.store.plugin.serverStats.paneIconCorners?.[session.id] || 'bottom-right' }
    setPaneIconCorner(session: any, corner: string): void {
        const root = (window as any).harness
        const conf = root.config.store.plugin.serverStats
        conf.paneIconCorners = { ...conf.paneIconCorners, [session.id]: corner }
        root.config.changed$.next()
    }
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
    async fetchHoveredStats(session: any, metrics: any[], force = false) {
        const root = (window as any).harness
        root.hoverCalls.push({ ids: metrics.map(metric => metric.id), force, at: Date.now() })
        const blocked = metrics.find(metric => root.hoverBlockedIds.includes(metric.id))
        if (blocked) await new Promise<void>(resolve => { root.hoverResolvers[blocked.id] = resolve })
        return root.stats
    }
    async fetchDetails(session: any, metrics: any[], options?: any) {
        const root = (window as any).harness
        root.detailCalls.push(metrics.map(metric => metric.id))
        root.detailRequests.push({ ids: metrics.map(metric => metric.id), options })
        await new Promise(resolve => setTimeout(resolve, root.detailDelay || 0))
        if (root.detailThrows) throw new Error('Mock detail connection failure')
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
