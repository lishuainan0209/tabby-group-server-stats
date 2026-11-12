/** Display preferences must not reset collectors, in-flight work or retry timers. */
export function collectionConfigSignature(store: any): string {
    const conf = store?.plugin?.serverStats || {}
    return JSON.stringify([
        conf.customMetrics, conf.metricGroups, conf.defaultMetrics,
        conf.defaultMetricOverrides, conf.defaultInterval, store?.profiles,
    ])
}
