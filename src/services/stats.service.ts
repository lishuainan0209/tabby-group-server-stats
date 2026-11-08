import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { CustomMetric, CustomMetricGroup, MetricStatus, allMetrics, metricTimeout, buildMetricCommand, parseMetricResults, shellQuote } from '../metric-model'
import { filterScopedMetrics, ScopeContext } from '../display-scope'
import { MetricScopeService, PaneGroupMode } from './metric-scope.service'
import { getBuiltinDefinitions, migrateLegacyBuiltinConfig } from '../builtin-metrics'
import { exec } from 'child_process'
import { Subject } from 'rxjs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const LOG_FILE = path.join(os.tmpdir(), 'tabby-server-stats.log');
let logCounter = 0;
function logDebug(msg: string) {
    if (!StatsService.isDebugEnabled) {
        return;
    }
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        logCounter++;
        if (logCounter % 100 === 0) {
            try {
                const stat = fs.statSync(LOG_FILE);
                if (stat.size > 2 * 1024 * 1024) {
                    fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] [log rotated]\n`);
                }
            } catch {}
        }
        fs.appendFileSync(LOG_FILE, line);
    } catch {}
    console.log(`[ServerStats] ${msg}`);
}

interface MetricState {
    lastAttempt: number
    lastSuccess: number
    value: string
    isFetching: boolean
    status: MetricStatus
    detail: string
    detailAt: number
}

interface SessionCache {
    scopeSignature: string
    metricStates: Map<string, MetricState>
}

// Limit bursts of shell processes when a large group becomes due together.
// Value and hover batches may coexist, but each runs at most four metrics.
const METRIC_BATCH_CONCURRENCY = 4;

@Injectable({ providedIn: 'root' })
export class StatsService {
    public static isDebugEnabled = false;
    private serverCaches = new Map<string, SessionCache>();
    private fetchTasks = new Map<string, Promise<any>>();
    private detailTasks = new Map<string, Promise<string>>();
    private sessionKeys = new WeakMap<object, string>();
    private nextSessionId = 0;
    private revision = 0;
    public statsUpdated$ = new Subject<{ serverKey: string; stats: any }>();

    constructor(private config: ConfigService, private scopes: MetricScopeService = null) {
        this.updateDebugState();
        this.config.changed$.subscribe(() => {
            this.updateDebugState();
            this.revision++;
            this.serverCaches.clear();
            this.fetchTasks.clear();
            this.detailTasks.clear();
        });
        this.config.ready$.subscribe(() => {
            const conf = this.config?.store?.plugin?.serverStats;
            if (conf && migrateLegacyBuiltinConfig(conf)) this.config.save();
            this.updateDebugState();
        });
    }

    private updateDebugState() {
        StatsService.isDebugEnabled = Boolean(this.config?.store?.plugin?.serverStats?.debugLogging);
    }

    public getServerKey(session: any): string {
        if (!session || typeof session !== 'object') return 'default';
        let key = this.sessionKeys.get(session);
        if (!key) {
            // Two connections using one saved profile must not share late results.
            key = `session:${++this.nextSessionId}`;
            this.sessionKeys.set(session, key);
        }
        return key;
    }

    private scopeContext(session: any): ScopeContext {
        return this.scopes?.contextForSession(session) || { profileIds: session?.profile?.id ? [session.profile.id] : [] };
    }

    public isPaneVisible(session: any): boolean {
        return this.scopes?.isPaneVisible?.(session) ?? true;
    }

    public setPaneVisible(session: any, visible: boolean): void {
        this.scopes?.setPaneVisible?.(session, visible);
    }

    public getPaneGroupMode(session: any): PaneGroupMode | undefined {
        return this.scopes?.getPaneGroupMode?.(session);
    }

    public setPaneGroupMode(session: any, mode: PaneGroupMode): void {
        this.scopes?.setPaneGroupMode?.(session, mode);
    }

    /** Disabled/out-of-scope commands never run. Unavailable items still refresh to detect recovery. */
    public getVisibleConfig(session: any): { customMetrics: CustomMetric[]; metricGroups: CustomMetricGroup[] } {
        const conf = this.config?.store?.plugin?.serverStats || {};
        const builtins = getBuiltinDefinitions(conf);
        return filterScopedMetrics({
            customMetrics: [...builtins.customMetrics, ...(conf.customMetrics || [])],
            metricGroups: [...builtins.metricGroups, ...(conf.metricGroups || [])]
        }, this.scopeContext(session), this.config?.store?.profiles || []);
    }

    private scopeSignature(session: any): string {
        const context = this.scopeContext(session);
        const visible = this.getVisibleConfig(session);
        return JSON.stringify([
            [...new Set(context.profileIds)].sort(),
            allMetrics(visible).map(metric => metric.id).sort()
        ]);
    }

    private discardSessionCache(key: string) {
        this.serverCaches.delete(key);
        this.fetchTasks.delete(key);
        for (const taskKey of this.detailTasks.keys()) {
            if (taskKey.startsWith(`${key}:`)) this.detailTasks.delete(taskKey);
        }
    }

    private getSessionCache(session: any): SessionCache {
        const key = this.getServerKey(session);
        const scopeSignature = this.scopeSignature(session);
        let cache = this.serverCaches.get(key);
        if (cache && cache.scopeSignature !== scopeSignature) {
            this.discardSessionCache(key);
            cache = undefined;
        }
        if (!cache) {
            cache = {
                scopeSignature,
                metricStates: new Map<string, MetricState>()
            };
            this.serverCaches.set(key, cache);
        }
        return cache;
    }

    private snapshot(cache: SessionCache, session: any): any {
        const metrics = allMetrics(this.getVisibleConfig(session));
        const ids = new Set(metrics.map(metric => metric.id));
        const numeric = (id: string) => {
            const state = ids.has(id) ? cache.metricStates.get(id) : undefined;
            const value = state?.status === 'ok' ? Number.parseFloat(state.value) : 0;
            return Number.isFinite(value) ? value : 0;
        };
        return {
            // Retain the original public snapshot shape for external consumers.
            // All values now come from the same editable, scoped definitions.
            cpu: numeric('builtin-cpu'), mem: numeric('builtin-ram'), disk: numeric('builtin-disk'),
            netRx: numeric('builtin-net-rx') * 1024, netTx: numeric('builtin-net-tx') * 1024,
            custom: metrics.map(metric => {
                const state = cache.metricStates.get(metric.id);
                return { id: metric.id, value: state?.value ?? '-', status: state?.status ?? 'pending' };
            })
        };
    }

    getCachedStats(session: any): any | null {
        if (!session || session.open === false) return null;
        const key = this.getServerKey(session);
        const cache = this.serverCaches.get(key);
        if (cache && cache.scopeSignature !== this.scopeSignature(session)) {
            this.discardSessionCache(key);
            return null;
        }
        return cache ? this.snapshot(cache, session) : null;
    }

    private getState(cache: SessionCache, metric: CustomMetric): MetricState {
        let state = cache.metricStates.get(metric.id);
        if (!state) {
            state = { lastAttempt: 0, lastSuccess: 0, value: '-', status: 'pending', isFetching: false, detail: '', detailAt: 0 };
            cache.metricStates.set(metric.id, state);
        }
        return state;
    }

    private isCurrent(session: any, cache: SessionCache, revision: number): boolean {
        return session.open !== false && this.revision === revision && this.serverCaches.get(this.getServerKey(session)) === cache &&
            cache.scopeSignature === this.scopeSignature(session);
    }

    private publish(session: any, cache: SessionCache, revision: number) {
        if (this.isCurrent(session, cache, revision)) {
            this.statsUpdated$.next({ serverKey: this.getServerKey(session), stats: this.snapshot(cache, session) });
        }
    }

    isPlatformSupport(session: any): boolean {
        if (!session || session.open === false) return false;
        const sshClient = session.ssh?.ssh;
        return Boolean(sshClient && typeof sshClient.openSessionChannel === 'function') ||
            process.platform === 'linux' || process.platform === 'darwin' || Boolean(this.getLocalShell());
    }

    private getLocalShell(): string | null {
        if (process.platform !== 'win32') return null;
        return [
            process.env.MSYS2_SH,
            ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'sh.exe')),
            'C:\\msys64\\usr\\bin\\sh.exe',
            'C:\\msys32\\usr\\bin\\sh.exe'
        ].find(shell => Boolean(shell && fs.existsSync(shell))) || null;
    }

    private async execute(session: any, command: string, timeoutMs: number, onChunk?: (buffer: string) => void): Promise<string> {
        if (!this.isPlatformSupport(session)) throw new Error('Session unavailable');
        logDebug(`[execute] ${this.getServerKey(session)}, timeout=${timeoutMs}ms, length=${command.length}`);
        const sshClient = session.ssh?.ssh;
        if (sshClient && typeof sshClient.openSessionChannel === 'function') {
            return this.exec(sshClient, command, timeoutMs, onChunk);
        }
        return this.execLocal(command, timeoutMs, this.getLocalShell());
    }

    async fetchStats(session: any): Promise<any | null> {
        if (!this.isPlatformSupport(session)) return null;
        // Refresh context before looking up the task. A pane may have moved to a
        // different saved layout without changing its session object.
        this.getSessionCache(session);
        const key = this.getServerKey(session);
        const active = this.fetchTasks.get(key);
        if (active) return active;
        const task = this.collectStats(session);
        this.fetchTasks.set(key, task);
        try {
            return await task;
        } finally {
            if (this.fetchTasks.get(key) === task) this.fetchTasks.delete(key);
        }
    }

    private async collectStats(session: any): Promise<any | null> {
        const cache = this.getSessionCache(session);
        const revision = this.revision;
        const now = Date.now();
        const conf = this.config?.store?.plugin?.serverStats || {};
        const defaultInterval = Number.isFinite(conf.defaultInterval) && conf.defaultInterval > 0 ? conf.defaultInterval : 10;
        const due = allMetrics(this.getVisibleConfig(session)).filter(metric => {
            const state = this.getState(cache, metric);
            const interval = Number.isFinite(metric.interval) && metric.interval! > 0 ? metric.interval! : defaultInterval;
            // Absent optional objects (for example unused GPU slots) still recover,
            // but need not launch a failing probe every normal refresh cycle.
            const retryInterval = state.status === 'unavailable' && metric.visibleWhenUnavailable === false ? Math.max(60, interval) : interval;
            return !state.isFetching && !this.detailTasks.has(`${this.getServerKey(session)}:${metric.id}`) &&
                (state.lastAttempt === 0 || now - state.lastAttempt >= Math.max(1, retryInterval) * 1000);
        });
        if (!due.length) return this.snapshot(cache, session);
        logDebug(`[collect] ${this.getServerKey(session)}, metrics=${due.length}`);
        const tokens = new Map(due.map((metric, index) => [`m_${index}`, metric]));
        const consumed = new Set<string>();
        due.forEach(metric => {
            const state = this.getState(cache, metric);
            state.isFetching = true;
            state.lastAttempt = now;
        });
        const onBuffer = (buffer: string) => {
            if (!this.isCurrent(session, cache, revision)) return;
            let changed = false;
            for (const result of parseMetricResults(buffer)) {
                const metric = tokens.get(result.token);
                if (!metric || consumed.has(result.token)) continue;
                consumed.add(result.token);
                const state = this.getState(cache, metric);
                // Its complete frame means this metric is no longer running, even
                // while an unrelated slower sibling keeps the batch channel open.
                state.isFetching = false;
                state.status = result.status;
                state.value = result.status === 'unavailable' ? (metric.unavailableText ?? 'Unavailable') : result.value;
                logDebug(`[metric] ${metric.id}: ${result.status}`);
                if (result.status === 'ok') state.lastSuccess = Date.now();
                else { state.detail = ''; state.detailAt = 0; }
                changed = true;
            }
            if (changed) this.publish(session, cache, revision);
        };
        const batch = this.commandBatch(tokens);
        try {
            const buffer = await this.execute(session, batch.script, batch.timeout, onBuffer);
            onBuffer(buffer);
            // A channel that closes without a complete result is an error, not a fresh cached value.
            if (this.isCurrent(session, cache, revision)) {
                tokens.forEach((metric, token) => {
                    if (!consumed.has(token)) {
                        const state = this.getState(cache, metric);
                        state.status = 'error'; state.value = 'Err: No result'; state.detail = ''; state.detailAt = 0;
                    }
                });
            }
        } catch (error: any) {
            logDebug(`[collect:error] ${error?.message || error}`);
            if (this.isCurrent(session, cache, revision)) {
                tokens.forEach((metric, token) => {
                    if (!consumed.has(token)) {
                        const state = this.getState(cache, metric);
                        state.status = 'error';
                        state.value = this.executionErrorValue(error);
                        state.detail = ''; state.detailAt = 0;
                    }
                });
            }
        } finally {
            due.forEach(metric => { this.getState(cache, metric).isFetching = false; });
            this.publish(session, cache, revision);
        }
        return this.isCurrent(session, cache, revision) ? this.snapshot(cache, session) : null;
    }

    private commandBatch(tokens: Map<string, CustomMetric>, kind: 'value' | 'detail' = 'value'): { script: string; timeout: number } {
        const entries = [...tokens.entries()];
        const parts = ['export LC_ALL=C PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"'];
        let seconds = 5;
        for (let offset = 0; offset < entries.length; offset += METRIC_BATCH_CONCURRENCY) {
            const wave = entries.slice(offset, offset + METRIC_BATCH_CONCURRENCY);
            wave.forEach(([token, metric]) => parts.push(buildMetricCommand(metric, token, kind)));
            parts.push('wait');
            // A metric can run a prerequisite and its command, each with a timeout.
            // Account for every sequential wave, including timeout kill grace.
            seconds += Math.max(...wave.map(([, metric]) => metricTimeout(metric) * 2 + 5));
        }
        parts.push('echo TABBY-STATS-END', '');
        return { script: parts.join('\n'), timeout: Math.max(15, seconds) * 1000 };
    }

    /** Hover details share the metric's refresh interval and deduplicate in-flight requests. */
    async fetchDetails(session: any, metrics: CustomMetric[]): Promise<Record<string, string>> {
        if (!this.isPlatformSupport(session)) return {};
        const key = this.getServerKey(session);
        const revision = this.revision;
        const cache = this.getSessionCache(session);
        const active = this.fetchTasks.get(key);
        const current = new Map(allMetrics(this.getVisibleConfig(session)).map(metric => [metric.id, metric]));
        // A streamed result can be expanded immediately. Only wait for the batch
        // when a requested metric itself has not completed its current command.
        const waitingForRequestedMetric = metrics.some(input => {
            const metric = current.get(input.id);
            if (!metric?.detailCommand?.trim()) return false;
            const state = cache.metricStates.get(metric.id);
            return !state || state.isFetching || state.status === 'pending';
        });
        if (active && waitingForRequestedMetric) await active;
        if (!this.isCurrent(session, cache, revision)) return {};
        const results: Record<string, string> = {};
        const requested = [...new Map(metrics.map(metric => [metric.id, metric])).values()];
        const fresh: CustomMetric[] = [];
        const pending = new Map<string, Promise<string>>();
        for (const input of requested) {
            const metric = current.get(input.id);
            if (!metric?.detailCommand?.trim()) continue;
            const state = this.getState(cache, metric);
            if (state.status === 'unavailable' || state.status === 'error') { results[metric.id] = ''; continue; }
            const configuredDefault = this.config?.store?.plugin?.serverStats?.defaultInterval;
            const defaultInterval = Number.isFinite(configuredDefault) && configuredDefault > 0 ? configuredDefault : 10;
            const interval = Number.isFinite(metric.interval) && metric.interval! > 0 ? metric.interval! : defaultInterval;
            if (state.detailAt && Date.now() - state.detailAt < Math.max(1, interval) * 1000) { results[metric.id] = state.detail; continue; }
            const taskKey = `${key}:${metric.id}`;
            const task = this.detailTasks.get(taskKey);
            if (task) pending.set(metric.id, task);
            else fresh.push(metric);
        }
        if (fresh.length) {
            // A group hover opens one SSH channel, not one channel per label.
            const batch = this.collectDetails(session, fresh, cache, revision);
            for (const metric of fresh) {
                const task = batch.then(values => values[metric.id] ?? '');
                this.detailTasks.set(`${key}:${metric.id}`, task);
                pending.set(metric.id, task);
            }
        }
        await Promise.all([...pending].map(async ([id, task]) => {
            const taskKey = `${key}:${id}`;
            try { results[id] = await task; }
            finally { if (this.detailTasks.get(taskKey) === task) this.detailTasks.delete(taskKey); }
        }));
        return this.isCurrent(session, cache, revision) ? results : {};
    }

    private async collectDetails(session: any, metrics: CustomMetric[], cache: SessionCache, revision: number): Promise<Record<string, string>> {
        const tokens = new Map(metrics.map((metric, index) => [index === 0 ? 'detail' : `detail_${index}`, metric]));
        const results: Record<string, string> = {};
        const consume = (buffer: string) => {
            if (!this.isCurrent(session, cache, revision)) return;
            for (const result of parseMetricResults(buffer)) {
                const metric = tokens.get(result.token);
                if (!metric || Object.prototype.hasOwnProperty.call(results, metric.id)) continue;
                const state = this.getState(cache, metric);
                if (result.status === 'unavailable') {
                    state.status = 'unavailable'; state.value = metric.unavailableText ?? 'Unavailable';
                    state.detail = ''; state.detailAt = 0;
                    this.publish(session, cache, revision);
                } else {
                    state.detail = result.value;
                    state.detailAt = Date.now();
                    if (result.status === 'error') logDebug(`[detail:error] ${metric.id}: ${state.detail}`);
                }
                results[metric.id] = state.detail;
            }
        };
        let failure = 'Err: No result';
        try {
            const batch = this.commandBatch(tokens, 'detail');
            consume(await this.execute(session, batch.script, batch.timeout, consume));
        } catch (error: any) {
            failure = this.executionErrorValue(error);
        }
        if (!this.isCurrent(session, cache, revision)) return {};
        for (const metric of metrics) {
            if (Object.prototype.hasOwnProperty.call(results, metric.id)) continue;
            const state = this.getState(cache, metric);
            state.detail = failure;
            state.detailAt = Date.now();
            logDebug(`[detail:error] ${metric.id}: ${state.detail}`);
            results[metric.id] = state.detail;
        }
        return results;
    }

    private executionErrorValue(error: any): string {
        const message = String(error?.message || error);
        if (message.includes('Timeout')) return 'Err: Timeout';
        const diagnostic = message.match(/^Stats: (No output|Incomplete output|No result|Remote error(?:: [\s\S]*)?)$/);
        return diagnostic ? `Err: ${diagnostic[1]}` : 'Err: Connection';
    }


    private execLocal(cmd: string, timeoutMs: number = 45000, shell?: string | null): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(cmd, { timeout: timeoutMs, ...(shell ? { shell } : {}) }, (error, stdout) => {
                if (error) reject(new Error(error.killed ? 'Stats: Timeout' : error.message));
                else resolve(stdout);
            });
        });
    }

    private exec(sshClient: any, cmd: string, timeoutMs: number = 45000, onChunk?: (buffer: string) => void): Promise<string> {
        const needsAcknowledgement = cmd.includes('TABBY-STATS-END');
        // russh discards a channel's event buffer on Close. Keep this dedicated
        // exec shell alive until the client receives END; merely waiting longer
        // on the client cannot recover data delivered after that buffer deletion.
        // The server-side wait is bounded even if the client disappears.
        const watchdogRead = `
_tabby_reader=$$
(
    trap 'kill "$_tabby_sleep" 2>/dev/null; exit 0' TERM
    sleep 5 & _tabby_sleep=$!
    wait "$_tabby_sleep"
    kill -TERM "$_tabby_reader" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
_tabby_watchdog=$!
trap 'kill "$_tabby_watchdog" 2>/dev/null; exit 0' TERM
IFS= read -r _tabby_ack
kill "$_tabby_watchdog" 2>/dev/null
wait "$_tabby_watchdog" 2>/dev/null
exit 0
`;
        const acknowledgementWait = `
# TABBY-STATS-ACK-WAIT
if command -v timeout >/dev/null 2>&1 && timeout -k 1 1 /bin/sh -c ':' >/dev/null 2>&1; then
    timeout -k 1 5 /bin/sh -c 'IFS= read -r _tabby_ack' || :
elif command -v gtimeout >/dev/null 2>&1 && gtimeout -k 1 1 /bin/sh -c ':' >/dev/null 2>&1; then
    gtimeout -k 1 5 /bin/sh -c 'IFS= read -r _tabby_ack' || :
else
    /bin/sh -c ${shellQuote(watchdogRead)}
fi
`;
        // Keep the SSH exec request tiny: embedding a batch here can exceed the
        // server's packet/argv limits and disconnect every channel in the session.
        // A compound command is parsed completely before it executes, so command
        // stdin cannot consume later script lines. Nothing follows its closing
        // brace: the next stdin bytes are exclusively the client's acknowledgment.
        const shellCommand = '/bin/sh -s';
        const script = Buffer.from(`{\n${cmd}\n${needsAcknowledgement ? acknowledgementWait : ''}\nexit\n}\n`, 'utf8');
        return new Promise((resolve, reject) => {
            let channel: any = null;
            let completed = false;
            let buffer = '';
            let stderr = '';
            let closing = false;
            let acknowledging = false;
            let uploadComplete = false;
            let endReceived = false;
            let drainTimer: ReturnType<typeof setTimeout> | undefined;
            let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
            const subscriptions: any[] = [];
            const decoder = new TextDecoder('utf-8');
            const errorDecoder = new TextDecoder('utf-8');
            const finish = (error?: Error) => {
                if (completed) return;
                completed = true;
                clearTimeout(timer);
                clearTimeout(drainTimer);
                clearTimeout(acknowledgementTimer);
                buffer += decoder.decode();
                stderr += errorDecoder.decode();
                // A remote shell can fail before our wrapper emits a result. Keep
                // its diagnostic separate from a successful (possibly empty) value.
                const expectedProtocol = cmd.includes('TABBY-METRIC-RESULT:') || cmd.includes('TABBY-STATS-START');
                const hasResult = parseMetricResults(buffer).length > 0 || /(?:^|\n)TABBY-STATS-START[^\r\n]*\r?\n/.test(buffer);
                if (!error && expectedProtocol && !hasResult) {
                    const remoteError = stderr.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 500);
                    const reason = remoteError ? `Remote error: ${remoteError}` :
                        !buffer.trim() ? 'No output' : buffer.includes('TABBY-METRIC-RESULT:') ? 'Incomplete output' : 'No result';
                    error = new Error(`Stats: ${reason}`);
                }
                for (const subscription of subscriptions) {
                    try { subscription.unsubscribe(); } catch {}
                }
                try { Promise.resolve(channel?.close()).catch(() => {}); } catch {}
                if (error) reject(error); else resolve(buffer);
            };
            const timer = setTimeout(() => finish(new Error('Stats: Timeout')), timeoutMs);
            const acknowledgeOutput = () => {
                if (completed || acknowledging) return;
                if (!needsAcknowledgement) { finish(); return; }
                if (!endReceived) {
                    endReceived = true;
                    clearTimeout(timer);
                    clearTimeout(drainTimer);
                    // END may arrive while the final upload write is resolving.
                    // Bound this wait too, without replacing complete results.
                    acknowledgementTimer = setTimeout(() => finish(), 1000);
                }
                if (!uploadComplete) return;
                acknowledging = true;
                try {
                    const acknowledgment = channel.write(Buffer.from('TABBY-STATS-ACK\n'));
                    Promise.resolve(acknowledgment).then(() => finish(), () => finish());
                } catch { finish(); }
            };
            const drain = () => {
                closing = true;
                clearTimeout(drainTimer);
                // russh delivers close and stdout through separate observables.
                // Drain until stdout has been quiet, not a fixed delay measured
                // from an earlier close notification that may precede final data.
                drainTimer = setTimeout(() => finish(), 100);
            };
            const subscribe = (observable: any, observer: any) => {
                const subscription = observable.subscribe(observer);
                // Buffered observables may synchronously finish during subscribe.
                if (completed) subscription.unsubscribe(); else subscriptions.push(subscription);
            };
            const open = async () => {
                const pendingChannel = await sshClient.openSessionChannel();
                if (completed) { try { pendingChannel?.close(); } catch {} return; }
                channel = await sshClient.activateChannel(pendingChannel);
                if (completed) { try { channel?.close(); } catch {} return; }
                if (!channel.data$) throw new Error('Channel has no data observable');
                subscribe(channel.data$, {
                    next: (chunk: any) => {
                        if (completed) return;
                        if (typeof chunk === 'string') buffer += chunk;
                        else if (Buffer.isBuffer(chunk) || chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) {
                            buffer += decoder.decode(chunk, { stream: true });
                        } else buffer += String(chunk);
                        onChunk?.(buffer);
                        if (/(?:^|\n)TABBY-STATS-END\r?\n/.test(buffer)) acknowledgeOutput();
                        else if (closing) drain();
                    },
                    error: (error: Error) => finish(error),
                    complete: drain
                });
                if (completed) return;
                if (channel.closed$) subscribe(channel.closed$, drain);
                if (channel.extendedData$) subscribe(channel.extendedData$, {
                    next: (event: any) => {
                        // russh's extendedData$ emits [SSH extended-data type, bytes].
                        const chunk = Array.isArray(event) ? event[1] : event;
                        if (typeof chunk === 'string') stderr += chunk;
                        else if (Buffer.isBuffer(chunk) || chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) stderr += errorDecoder.decode(chunk, { stream: true });
                        stderr = stderr.slice(-2048);
                        if (closing) drain();
                    }, error: (error: Error) => finish(error)
                });
                if (completed) return;
                if (typeof channel.write !== 'function') throw new Error('SSH channel does not support stdin upload');
                if (typeof channel.requestExec === 'function') await channel.requestExec(shellCommand);
                else if (typeof channel.exec === 'function') await channel.exec(shellCommand);
                else throw new Error('Channel has no exec method');
                // Await bounded writes to honor channel backpressure and keep
                // UTF-8 byte sequences intact across transport packet boundaries.
                for (let offset = 0; offset < script.length; offset += 8192) {
                    if (completed || closing) return;
                    await channel.write(script.subarray(offset, offset + 8192));
                }
                if (completed) return;
                uploadComplete = true;
                if (endReceived) acknowledgeOutput();
                else if (!needsAcknowledgement && typeof channel.eof === 'function') await channel.eof();
            };
            open().catch((error: Error) => finish(error));
        });
    }
}
