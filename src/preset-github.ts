import { MetricPreset, normalizePresetLibrary } from './preset-library'

export const DEFAULT_GITHUB_PRESETS_URL = 'https://raw.githubusercontent.com/lishuainan0209/tabby-group-server-stats/main/presets.json'
export const GITHUB_PRESETS_MAX_BYTES = 2 * 1024 * 1024
export const GITHUB_PRESETS_TIMEOUT_MS = 15000

export type PresetGitHubErrorCode = 'invalid-url' | 'http' | 'timeout' | 'too-large' | 'invalid-json' | 'invalid-library' | 'network' | 'aborted'
const messages: Record<PresetGitHubErrorCode, string> = {
    'invalid-url': 'Only GitHub JSON file URLs are supported.',
    http: 'GitHub returned an HTTP error.',
    timeout: 'GitHub preset download timed out.',
    'too-large': 'GitHub preset file is too large.',
    'invalid-json': 'GitHub preset file is not valid JSON.',
    'invalid-library': 'GitHub preset file has an unsupported format.',
    network: 'Unable to download presets from GitHub.',
    aborted: 'GitHub preset download was canceled.'
}

export class PresetGitHubError extends Error {
    readonly name = 'PresetGitHubError'
    constructor(public readonly code: PresetGitHubErrorCode, public readonly status?: number) { super(messages[code]) }
}

export interface GitHubPresetOptions {
    /** Defaults to 15 seconds, including the response body. */
    timeoutMs?: number
    /** May lower the 2 MiB ceiling, never raise it. */
    maxBytes?: number
    fetch?: typeof fetch
    signal?: AbortSignal
}

/** Convert a public GitHub file page into its raw URL. Strip optional view/query
 * parameters so neither credentials nor unrelated URL metadata are forwarded. */
export function resolveGitHubPresetUrl(input: string = DEFAULT_GITHUB_PRESETS_URL): string {
    if (typeof input !== 'string') throw new PresetGitHubError('invalid-url')
    let url: URL
    try { url = new URL(input.trim() || DEFAULT_GITHUB_PRESETS_URL) }
    catch { throw new PresetGitHubError('invalid-url') }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new PresetGitHubError('invalid-url')
    if (url.hostname === 'github.com') {
        if (!/^\/[^/]+\/[^/]+\/blob\/[^/]+\/.+\.json$/i.test(url.pathname)) throw new PresetGitHubError('invalid-url')
        url.hostname = 'raw.githubusercontent.com'
        url.pathname = url.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, '$1/')
    } else if (url.hostname !== 'raw.githubusercontent.com' || !/^\/[^/]+\/[^/]+\/[^/]+\/.+\.json$/i.test(url.pathname)) {
        throw new PresetGitHubError('invalid-url')
    }
    try {
        if (url.pathname.split('/').some(segment => /[\x00-\x1f\x7f\\]/.test(decodeURIComponent(segment)))) throw new Error('Invalid path')
    } catch { throw new PresetGitHubError('invalid-url') }
    url.search = ''
    url.hash = ''
    return url.href
}

/** Read only a remote library. This helper never receives local configuration,
 * mutates existing presets, resolves profiles, or executes downloaded commands. */
export async function fetchGitHubPresets(input: string = DEFAULT_GITHUB_PRESETS_URL, options: GitHubPresetOptions = {}): Promise<MetricPreset[]> {
    const url = resolveGitHubPresetUrl(input)
    if (options.signal?.aborted) throw new PresetGitHubError('aborted')
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0 ? Math.min(options.timeoutMs!, 120000) : GITHUB_PRESETS_TIMEOUT_MS
    const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes! > 0 ? Math.min(options.maxBytes!, GITHUB_PRESETS_MAX_BYTES) : GITHUB_PRESETS_MAX_BYTES
    const controller = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let stopReason: PresetGitHubError | undefined
    let rejectStopped: (error: PresetGitHubError) => void = () => {}
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject })
    const stop = (error: PresetGitHubError) => {
        if (stopReason) return
        stopReason = error
        controller.abort()
        if (reader) void reader.cancel().catch(() => {})
        rejectStopped(error)
    }
    const aborted = () => stop(new PresetGitHubError('aborted'))
    options.signal?.addEventListener('abort', aborted, { once: true })
    const timer = setTimeout(() => stop(new PresetGitHubError('timeout')), timeoutMs)
    const download = async (): Promise<MetricPreset[]> => {
        const fetchImpl = options.fetch || fetch
        const response = await fetchImpl(url, {
            method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
            referrerPolicy: 'no-referrer', headers: { Accept: 'application/json, text/plain;q=0.9' }, signal: controller.signal
        })
        if (stopReason) throw stopReason
        if (!response.ok) throw new PresetGitHubError('http', response.status)
        const declaredLength = response.headers.get('content-length')
        if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
            if (response.body) void response.body.cancel().catch(() => {})
            throw new PresetGitHubError('too-large')
        }
        if (!response.body || typeof response.body.getReader !== 'function') throw new PresetGitHubError('invalid-json')
        reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let received = 0, text = ''
        while (true) {
            const { value, done } = await reader.read()
            if (stopReason) throw stopReason
            if (done) break
            received += value.byteLength
            if (received > maxBytes) throw new PresetGitHubError('too-large')
            try { text += decoder.decode(value, { stream: true }) }
            catch { throw new PresetGitHubError('invalid-json') }
        }
        let parsed: unknown
        try { text += decoder.decode(); parsed = JSON.parse(text) }
        catch { throw new PresetGitHubError('invalid-json') }
        try { return normalizePresetLibrary(parsed) }
        catch { throw new PresetGitHubError('invalid-library') }
    }
    try { return await Promise.race([download(), stopped]) }
    catch (error) {
        controller.abort()
        if (reader) void reader.cancel().catch(() => {})
        if (stopReason) throw stopReason
        if (error instanceof PresetGitHubError) throw error
        throw new PresetGitHubError('network')
    } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', aborted)
    }
}
