/**
 * Test implementation of Tabby's ConfigProxy contract, matching
 * tabby-core/src/services/config.service.ts (the installed host was inspected).
 *
 * Structural objects expose getter-only nested proxies. Declared leaf writes
 * update the backing raw object; unknown properties only exist on the proxy.
 * Empty object defaults are cloned on every read until a non-default value is
 * stored. Arrays and __nonStructural maps instead materialize a mutable raw
 * value on first access. Host helper methods are enumerable own properties.
 *
 * Only JSON-shaped config values are required here. Object/array checks are
 * realm-independent so Node VM fixtures and browser-bundled modules exercise
 * the same host behavior even when defaults originated in another test realm.
 */
type RecordValue = Record<string, any>

function cloneValue<T>(value: T): T {
    if (Array.isArray(value)) return value.map(cloneValue) as T
    if (value && typeof value === 'object') {
        const result = {}
        for (const key of Object.keys(value)) result[key] = cloneValue(value[key])
        return result as T
    }
    return value
}

function equalValues(a: any, b: any): boolean {
    if (a === b) return true
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        // Tabby's deep-equal uses its default non-strict primitive comparison.
        return a == b
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(key =>
        Object.prototype.hasOwnProperty.call(b, key) && equalValues(a[key], b[key]))
}

function structural(value: any): boolean {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length && !value.__nonStructural)
}

function mutableDefault(value: any): boolean {
    return Boolean(value && typeof value === 'object' && (Array.isArray(value) || value.__nonStructural))
}

export class HostConfigProxy<T extends RecordValue = RecordValue> {
    [key: string]: any

    constructor(raw: Partial<T>, defaults: T) {
        for (const key in defaults) {
            if (structural(defaults[key])) {
                if (!raw[key]) raw[key] = {} as any
                const nested = new HostConfigProxy(raw[key], defaults[key])
                Object.defineProperty(this, key, { enumerable: true, configurable: false, get: () => nested })
            } else {
                Object.defineProperty(this, key, { enumerable: true, configurable: false,
                    get: () => this.__getValue(key), set: value => this.__setValue(key, value) })
            }
        }
        this.__getValue = key => {
            if (raw[key] !== undefined) return raw[key]
            if (mutableDefault(defaults[key])) {
                raw[key] = this.__getDefault(key)
                delete raw[key].__nonStructural
                return raw[key]
            }
            return this.__getDefault(key)
        }
        this.__getDefault = key => cloneValue(defaults[key])
        this.__setDefaults = next => {
            for (const key in defaults) {
                if (structural(defaults[key]) && structural(next[key])) this[key].__setDefaults(next[key])
            }
            defaults = next
        }
        this.__setValue = (key, value) => {
            if (equalValues(value, this.__getDefault(key))) delete raw[key]
            else raw[key] = value
        }
        this.__cleanup = () => {
            for (const key in defaults) {
                if (structural(defaults[key])) this[key].__cleanup()
                else this.__setValue(key, this.__getValue(key))
            }
        }
    }

    __getValue(_key: keyof T): any {}
    __getDefault(_key: keyof T): any {}
    __setDefaults(_defaults: T): void {}
    __setValue(_key: keyof T, _value: any): void {}
    __cleanup(): void {}
}
