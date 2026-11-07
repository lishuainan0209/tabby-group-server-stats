import { Injectable } from '@angular/core'
import { ConfigProvider } from 'tabby-core'

import { CustomMetric, CustomMetricGroup, ColorCondition } from './metric-model'
import { METRIC_COLORS } from './metric-colors'
export { CustomMetric, CustomMetricGroup, ColorCondition, ConditionOperator, MetricStatus, MetricResult, DisplayScope } from './metric-model'

export { 
    getSvgPresetPath, 
    isSvgPreset, 
    isUrlOrDataUri, 
    isFaIcon, 
    formatFontAwesomeIcon, 
    TECH_ICON_PATHS,
    POPULAR_ICON_PRESETS,
    DEFAULT_METRIC_ICONS
} from './icons/presets';

export interface DefaultMetricsConfig {
    ram: boolean
    net: boolean
    load: boolean
    /** Retained only to migrate older editable definitions without data loss. */
    cpu?: boolean
    disk?: boolean
}

export function evaluateColor(value: any, rules?: ColorCondition[], defaultColor: string = METRIC_COLORS.green): string {
    if (!rules || rules.length === 0) {
        return defaultColor;
    }

    const rawStr = value !== undefined && value !== null ? String(value).trim() : '';
    const numMatch = rawStr.match(/-?\d+(?:\.\d+)?/);
    const numVal = numMatch ? parseFloat(numMatch[0]) : NaN;
    const isNum = !isNaN(numVal) && isFinite(numVal);

    for (const rule of rules) {
        if (!rule || !rule.color) continue;
        const ruleVal = rule.value !== undefined && rule.value !== null ? String(rule.value).trim() : '';
        const ruleNumMatch = ruleVal.match(/-?\d+(?:\.\d+)?/);
        const ruleNum = ruleNumMatch ? parseFloat(ruleNumMatch[0]) : NaN;
        const ruleIsNum = !isNaN(ruleNum) && isFinite(ruleNum);

        let matched = false;

        switch (rule.operator) {
            case '>=':
                if (isNum && ruleIsNum) matched = numVal >= ruleNum;
                break;
            case '>':
                if (isNum && ruleIsNum) matched = numVal > ruleNum;
                break;
            case '<=':
                if (isNum && ruleIsNum) matched = numVal <= ruleNum;
                break;
            case '<':
                if (isNum && ruleIsNum) matched = numVal < ruleNum;
                break;
            case '==':
                if (isNum && ruleIsNum && rawStr === String(numVal) && ruleVal === String(ruleNum)) {
                    matched = numVal === ruleNum;
                } else {
                    matched = rawStr.toLowerCase() === ruleVal.toLowerCase();
                }
                break;
            case '!=':
                if (isNum && ruleIsNum && rawStr === String(numVal) && ruleVal === String(ruleNum)) {
                    matched = numVal !== ruleNum;
                } else {
                    matched = rawStr.toLowerCase() !== ruleVal.toLowerCase();
                }
                break;
            case 'contains':
                matched = rawStr.toLowerCase().includes(ruleVal.toLowerCase());
                break;
            case 'not_contains':
                matched = !rawStr.toLowerCase().includes(ruleVal.toLowerCase());
                break;
            case 'starts_with':
                matched = rawStr.toLowerCase().startsWith(ruleVal.toLowerCase());
                break;
            case 'regex':
                try {
                    const re = new RegExp(ruleVal, 'i');
                    matched = re.test(rawStr);
                } catch {
                    matched = false;
                }
                break;
        }

        if (matched) {
            return rule.color;
        }
    }

    return defaultColor;
}

@Injectable()
export class ServerStatsConfigProvider extends ConfigProvider {
    defaults = {
        plugin: {
            serverStats: {
                enabled: true,
                // Kept for config compatibility; runtime always uses the bottom bar.
                displayMode: 'bottomBar',
                paneVisibility: { __nonStructural: true } as Record<string, boolean>,
                paneGroupModes: { __nonStructural: true } as Record<string, string | boolean>,
                defaultInterval: 3,
                debugLogging: false,
                location: { x: null, y: null },
                style: {
                    background: 'rgba(20, 20, 20, 0.90)',
                    size: 100,
                    layout: 'vertical'
                },
                defaultMetrics: {
                    ram: true,
                    net: true,
                    load: true,
                    cpu: false,
                    disk: false
                },
                builtinDefaultsVersion: 0,
                builtinOrder: ['ram', 'net', 'load'],
                defaultMetricOverrides: { __nonStructural: true },
                showDefaultIcons: true,
                customMetrics: [] as CustomMetric[],
                metricGroups: [] as CustomMetricGroup[]
            }
        }
    }
}
