/** Opt-in value protocol: display throughput while coloring by reference-bandwidth percentage. */
export function parseDiskIoValue(value: string): { value: string; colorValue: number } | null {
    const match = /^TABBY-IO:([0-9]+(?:\.[0-9]+)?):([0-9]+(?:\.[0-9]+)?)$/.exec(value)
    if (!match) return null
    const rate = Number(match[1]), percent = Number(match[2])
    if (!Number.isFinite(rate) || !Number.isFinite(percent)) return null
    return { value: match[1], colorValue: percent }
}
