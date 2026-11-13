import { Component, Injectable, HostListener, ViewChild, ElementRef, AfterViewInit, AfterViewChecked, OnDestroy } from '@angular/core'
import { DomSanitizer, SafeUrl } from '@angular/platform-browser'
import { ConfigService, PlatformService, TranslateService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { BuiltinMetricKey, getBuiltinDefinition, normalizeBuiltinOrder, migrateLegacyBuiltinConfig } from '../builtin-metrics'
import { MetricPreset, getBundledPresets, normalizePresetLibrary, instantiatePreset, exportPresetLibrary, findInstalledPreset } from '../preset-library'
import { DEFAULT_GITHUB_PRESETS_URL, fetchGitHubPresets, PresetGitHubError } from '../preset-github'
import { METRIC_COLORS } from '../metric-colors'
import { migrateDiskIoChecks } from '../disk-io'
import { TRANSLATIONS } from '../translations'
import { getLayoutPaneTargets, layoutPaneTargetName } from '../display-scope'
import { openTutorialPdf } from '../tutorial'
import {
    CustomMetric,
    CustomMetricGroup,
    DisplayScope,
    ColorCondition,
    formatFontAwesomeIcon,
    getSvgPresetPath,
    isUrlOrDataUri,
    isFaIcon,
    POPULAR_ICON_PRESETS
} from '../config'

interface ScopeChoice { id: string; name: string; type: string; group: string; disambiguator?: string; layoutId?: string; layoutName?: string; profileId?: string; connectionIds?: string[]; path?: number[]; storedName?: string }
interface IconPresetChoice { name: string; label: string; category?: string; keywords?: string | string[] }
interface ImportedPresetMetadata {
    importedLabel: string
    labels?: MetricPreset['labels']
    description?: string
    descriptions?: MetricPreset['descriptions']
    source?: MetricPreset['source']
    audience?: MetricPreset['audience']
}
type PresetItem = (CustomMetric | CustomMetricGroup) & { presetMetadata?: ImportedPresetMetadata }

@Component({
    selector: 'server-stats-settings',
    template: `
        <div class="settings-heading">
            <h3 translate>Bottom Status Bar</h3>
            <button type="button" class="btn tutorial-button" [disabled]="tutorialOpening" [attr.aria-busy]="tutorialOpening" (click)="openTutorial()"><i class="fas fa-book-open" aria-hidden="true"></i> <span translate>Tutorial (PDF)</span></button>
        </div>
        <div *ngIf="tutorialError" class="alert alert-warning tutorial-error" role="alert">{{tutorialError}}</div>
        <div class="form-line">
            <div class="header"><div class="title" translate>Show bottom status bar</div></div>
            <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" id="statusBarEnabled" [(ngModel)]="config.store.plugin.serverStats.enabled" (ngModelChange)="save()" [attr.aria-label]="'Show bottom status bar' | translate">
            </div>
        </div>

        <!-- 样式配置 -->
        <div class="form-line">
            <div class="header">
                <div class="title" translate>Background Color</div>
                <div class="description" translate>Background color and opacity</div>
            </div>
            <div class="d-flex align-items-center">
                <input type="color" class="form-control form-control-color me-3"
                    style="width: 60px;"
                    [ngModel]="hexColor"
                    (ngModelChange)="setHexColor($event)">
                <span class="text-muted me-2" translate>Opacity</span>
                <input type="range" class="form-range me-2" style="width: 100px" min="0" max="1" step="0.01"
                    [ngModel]="opacity"
                    (ngModelChange)="setOpacity($event)">
            </div>
        </div>

        <!-- 默认更新周期配置 -->
        <div class="form-line">
            <div class="header">
                <div class="title" translate>Default Update Interval</div>
                <div class="description" translate>Base interval (in seconds) for collecting metrics</div>
            </div>
            <div class="d-flex align-items-center">
                <input type="number" class="form-control form-control-sm" style="width: 90px;" min="1" max="3600"
                    [(ngModel)]="defaultInterval"
                    (ngModelChange)="save()">
                <span class="text-muted ms-2" translate>seconds</span>
            </div>
        </div>

        <!-- 调试日志配置 -->
        <div class="form-line">
            <div class="header">
                <div class="title" translate>Debug Logging</div>
                <div class="description" translate>Write detailed execution logs to file for troubleshooting</div>
            </div>
            <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" id="debugLogging"
                    [(ngModel)]="debugLogging"
                    (ngModelChange)="save()">
            </div>
        </div>

        <section class="settings-section builtin-metrics mt-4 mb-3">
            <h4 translate>Default Metrics</h4>
            <p class="text-muted" translate>Edit built-in commands and appearance, or restore an item to its defaults.</p>
            <p class="text-muted builtin-order-help" translate>Move items up or down to set their order in the bottom status bar.</p>
            <div class="list-group-item custom-metric-item builtin-card p-3 mb-2" *ngFor="let key of builtinKeys; let b = index" [attr.data-builtin]="key" [class.metric-disabled]="defaultMetricsConfig[key] === false">
                <div class="builtin-header">
                    <div class="group-summary">
                        <span class="group-card-icon"><ng-container *ngTemplateOutlet="metricIcon; context: { $implicit: builtinMain(key) }"></ng-container></span>
                        <strong>{{ builtinTitle(key) | translate }}</strong>
                        <span class="badge bg-secondary" *ngIf="key === 'net' || key === 'load'" translate>Metric Group</span>
                        <span class="badge bg-info" *ngIf="hasBuiltinOverride(key)" translate>Customized</span>
                    </div>
                    <div class="btn-group btn-group-sm builtin-actions">
                        <button type="button" class="btn btn-outline-secondary builtin-move-up" [disabled]="b === 0" (click)="moveBuiltin(key, -1)" [title]="'Move up' | translate" [attr.aria-label]="'Move up' | translate">↑</button>
                        <button type="button" class="btn btn-outline-secondary builtin-move-down" [disabled]="b === builtinKeys.length - 1" (click)="moveBuiltin(key, 1)" [title]="'Move down' | translate" [attr.aria-label]="'Move down' | translate">↓</button>
                        <button type="button" class="btn btn-outline-secondary builtin-enabled" (click)="toggleBuiltinEnabled(key)" [attr.aria-pressed]="defaultMetricsConfig[key] !== false">{{ (defaultMetricsConfig[key] === false ? 'Disabled' : 'Enabled') | translate }}</button>
                        <button type="button" class="btn btn-outline-secondary builtin-edit" (click)="editBuiltin(key)" [title]="'Edit' | translate" [attr.aria-label]="'Edit' | translate"><i class="fas fa-pen" aria-hidden="true"></i></button>
                        <button type="button" class="btn btn-outline-secondary builtin-reset" (click)="restoreBuiltin(key)" [disabled]="!hasBuiltinOverride(key)" translate>Restore defaults</button>
                    </div>
                </div>
                <p class="text-muted builtin-network-help mt-2 mb-0" *ngIf="key === 'net'" translate>Download and upload are current rates. Click to show separate received and sent totals since interface creation or counter reset, not since SSH login. Default-route interfaces are preferred; without a route, eligible non-loopback interfaces are used.</p>
                <div class="inline-item-editor" *ngIf="editingBuiltinKey === key"><ng-container *ngTemplateOutlet="itemEditor"></ng-container></div>
            </div>
            <div class="form-check form-switch mt-2">
                <input class="form-check-input" type="checkbox" id="showDefaultIcons" [(ngModel)]="showDefaultIcons" (ngModelChange)="save()">
                <label class="form-check-label" for="showDefaultIcons" translate>Show icons for default metrics</label>
            </div>
        </section>

        <div class="separator"></div>

        <section class="settings-section preset-library mt-4 mb-3">
            <div class="preset-library-header">
                <h4 class="mb-0" translate>Preset Library</h4>
                <div class="d-flex gap-2 flex-wrap">
                    <button type="button" class="btn btn-outline-primary btn-sm preset-github" (click)="fetchPresets()" [disabled]="loadingPresets" [attr.aria-busy]="loadingPresets">
                        <i class="fas fa-cloud-download-alt me-1" aria-hidden="true"></i>{{ (loadingPresets ? 'Loading...' : 'Import from GitHub') | translate }}
                    </button>
                    <input type="file" #presetFile accept=".json,application/json" (change)="importPresetFile($event)" hidden>
                    <button type="button" class="btn btn-outline-secondary btn-sm preset-import" (click)="presetFile.click()" [disabled]="loadingPresets" translate>Import JSON</button>
                    <button type="button" class="btn btn-outline-secondary btn-sm preset-export" (click)="exportCurrentPresets()" translate>Export my labels</button>
                </div>
            </div>
            <p class="text-muted mt-2" translate>Bundled presets work offline. Importing a library only previews it; commands run after you add a label or group.</p>
            <p class="preset-github-source"><span translate>GitHub source</span>: <button type="button" class="preset-source-link" (click)="openPresetSource()">lishuainan0209/tabby-group-server-stats · main</button></p>
            <input class="form-control form-control-sm preset-search" [(ngModel)]="presetSearch" [placeholder]="'Search presets' | translate" [attr.aria-label]="'Search presets' | translate">
            <div class="preset-message mt-2" role="status" [class.preset-error]="fetchError" *ngIf="presetMessage">{{ presetMessage | translate }}<span *ngIf="presetMissingNames.length">: {{ presetMissingNames.join(', ') }}</span></div>
            <div class="list-group mt-3 preset-list">
                <div class="list-group-item custom-metric-item preset-card p-3 mb-2" *ngFor="let p of filteredPresets; trackBy: trackPreset" [class.preset-lab-only]="p.audience === 'author-lab'">
                    <div class="preset-card-header">
                        <span class="group-card-icon"><ng-container *ngTemplateOutlet="metricIcon; context: { $implicit: presetMain(p) }"></ng-container></span>
                        <strong>{{ presetText(p, 'label') }}</strong>
                        <span class="badge bg-secondary">{{ (p.kind === 'group' ? 'Metric Group' : 'Single Labels') | translate }}</span>
                        <span class="badge preset-lab-badge" *ngIf="p.audience === 'author-lab'" translate>Author's lab only</span>
                        <button type="button" class="btn btn-outline-primary btn-sm preset-add" [disabled]="isPresetAdded(p)" (click)="addPreset(p)">{{(isPresetAdded(p) ? 'Already added' : 'Add') | translate}}</button>
                    </div>
                    <p class="preset-description mb-2" *ngIf="presetText(p, 'description')">{{ presetText(p, 'description') }}</p>
                    <div class="command-box group-command" [title]="presetMain(p)?.command">{{ presetMain(p)?.command }}</div>
                    <div class="preset-targets mt-2" *ngIf="p.profileNames?.length"><span translate>Suggested connections</span>: {{ p.profileNames.join(', ') }}</div>
                    <div class="preset-source mt-2" *ngIf="p.source"><span translate>Source</span>: {{ p.source.name }}<span *ngIf="p.source.license"> · {{ p.source.license }}</span></div>
                </div>
                <div class="text-muted p-3" *ngIf="filteredPresets.length === 0" translate>No presets match this search.</div>
            </div>
        </section>

        <div class="separator"></div>

        <!-- 自定义指标管理区域 -->
        <section class="settings-section single-labels-section mt-4 mb-3">
        <div class="mb-3">
            <div class="d-flex justify-content-between align-items-center gap-2">
                <h4 class="mb-0" translate>Single Labels</h4>
                <button type="button" class="btn btn-outline-primary btn-sm add-single-btn" (click)="newSingle()" translate>Add Single Label</button>
            </div>
            <div class="text-muted mt-2 mb-2" style="font-size: 13px;" translate>
                Define custom shell commands to fetch data. The command must output a single value (number or text).
            </div>
        </div>

        <div class="list-group mb-3">
            <div class="list-group-item user-select-none custom-metric-item p-3 mb-2"
                 *ngFor="let metric of customMetrics; let i = index"
                 [class.metric-disabled]="metric.enabled === false"
                 [draggable]="currentMetric.id !== metric.id || editingIndex === -1"
                 (dragstart)="onDragStart(i)"
                 (dragover)="onDragOver($event, i)"
                 (drop)="onDrop(i)"
                 [class.opacity-50]="draggedIndex === i && !isDragging"
                 style="cursor: grab; overflow: hidden;">

                <div class="d-flex align-items-start justify-content-between gap-3 w-100">
                    <!-- Drag handle -->
                    <div class="pt-1 flex-shrink-0">
                        <i class="fas fa-grip-vertical text-muted" style="cursor: grab; font-size: 14px;" title="{{ 'Drag to reorder' | translate }}"></i>
                    </div>

                    <!-- Content Area (with min-width: 0 to prevent overflow) -->
                    <div class="flex-grow-1" style="min-width: 0; overflow: hidden;">
                        <!-- Header row: Icon, Label, and Badges -->
                        <div class="d-flex align-items-center flex-wrap gap-2 mb-2">
                            <span class="d-inline-flex align-items-center justify-content-center flex-shrink-0" [style.color]="metric.color || '#00ff00'" *ngIf="metric.icon" style="width: 20px; height: 20px;">
                                <svg *ngIf="getSvgPath(metric.icon)" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path [attr.d]="getSvgPath(metric.icon)"></path>
                                </svg>
                                <img *ngIf="isUrl(metric.icon)" [src]="getSafeIconUrl(metric.icon)" width="16" height="16" style="object-fit: contain;" />
                                <i *ngIf="isFa(metric.icon)" [class]="getIconClass(metric.icon)" style="font-size: 15px;"></i>
                            </span>

                            <strong class="fs-6 text-truncate" style="max-width: 280px;" [title]="metric.label || metric.icon">
                                {{ metric.label || metric.icon }}
                            </strong>

                            <span class="badge" [style.background-color]="metric.color || '#666'">
                                {{ (metric.type === 'progress' ? 'Progress Bar' : 'Text Value') | translate }}
                            </span>

                            <span class="badge bg-secondary" *ngIf="metric.interval" title="{{ 'Execution Interval' | translate }}">
                                <i class="fas fa-clock me-1"></i>{{ metric.interval }}s
                            </span>

                            <span class="badge bg-warning text-dark" *ngIf="metric.timeout" title="{{ 'Timeout' | translate }}">
                                <i class="fas fa-stopwatch me-1"></i>{{ metric.timeout }}s
                            </span>

                            <span class="badge bg-info text-dark" *ngIf="metric.colorRules && metric.colorRules.length > 0" title="{{ 'Conditional Color Rules' | translate }}">
                                <i class="fas fa-palette me-1"></i>{{ metric.colorRules.length }} {{ (metric.colorRules.length === 1 ? 'rule' : 'rules') | translate }}
                            </span>
                        </div>

                        <!-- Command display: elegant monospace code snippet with line-clamp, text-break, and copy tooltip -->
                        <div class="command-box font-monospace text-muted p-2 rounded"
                             style="font-size: 11px; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.08); word-break: break-all; max-height: 48px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.4;"
                             [title]="metric.command">
                            {{ metric.command }}
                        </div>
                    </div>

                    <!-- Action buttons: always pinned right, never pushed away -->
                    <div class="btn-group btn-group-sm flex-shrink-0 pt-1">
                        <button type="button" class="btn btn-outline-secondary metric-enabled" (click)="toggleMetricEnabled(i)" [attr.aria-pressed]="metric.enabled !== false" [title]="(metric.enabled === false ? 'Enable metric' : 'Disable metric') | translate">{{ (metric.enabled === false ? 'Disabled' : 'Enabled') | translate }}</button>
                        <button class="btn btn-outline-secondary" (click)="editMetric(i)" [title]="'Edit' | translate">
                            <i class="fas fa-pen"></i>
                        </button>
                    </div>
                </div>
                <div class="inline-item-editor" *ngIf="!currentGroup && editingIndex !== -1 && currentMetric.id === metric.id">
                    <ng-container *ngTemplateOutlet="itemEditor"></ng-container>
                </div>
                <div class="card-delete-actions">
                    <button type="button" class="btn btn-outline-danger btn-sm metric-delete" (click)="removeMetric(i)"><i class="fas fa-trash" aria-hidden="true"></i> <span translate>Delete Metric</span> · {{ metric.label || metric.icon || ('Unnamed Metric' | translate) }}</button>
                </div>
            </div>

            <div class="list-group-item text-center text-muted p-4" *ngIf="customMetrics.length === 0" translate>
                No custom metrics defined.
            </div>
        </div>

        <div class="list-group new-item-editor" *ngIf="!editingBuiltinKey && editingIndex === -1 && !editingGroupId && newSingleOpen && !currentGroup">
            <div class="list-group-item custom-metric-item p-3"><ng-container *ngTemplateOutlet="itemEditor"></ng-container></div>
        </div>
        </section>

        <section class="settings-section metric-groups-section mt-4 mb-3">
            <div class="d-flex justify-content-between align-items-center gap-2">
                <h4 class="mb-0" translate>Metric Groups</h4>
                <button class="btn btn-outline-primary btn-sm" (click)="newGroup()" translate>Add Group</button>
            </div>
            <p class="text-muted mt-2" translate>Group a main metric and child metrics. Each metric keeps its own commands and refresh interval.</p>
            <div class="list-group metric-group-list">
                <div class="list-group-item custom-metric-item group-card p-3 mb-2" *ngFor="let group of metricGroups; let g = index" [class.metric-disabled]="group.enabled === false">
                    <div class="group-card-header">
                        <div class="group-card-heading">
                            <span class="group-card-icon" [style.color]="group.main.color || '#00ff00'">
                                <ng-container *ngTemplateOutlet="metricIcon; context: { $implicit: group.main }"></ng-container>
                                <i *ngIf="!group.main.icon" class="fas fa-layer-group" aria-hidden="true"></i>
                            </span>
                            <span class="group-summary">
                                <strong>{{ group.label || group.main.label || ('Metric Group' | translate) }}</strong>
                                <span class="badge bg-primary">{{ groupModeLabel(group.mode) | translate }}</span>
                                <span class="badge group-count">{{ group.children.length }} {{ 'Child Metrics' | translate }}</span>
                            </span>
                        </div>
                        <div class="btn-group btn-group-sm group-card-actions">
                            <button type="button" class="btn btn-outline-secondary group-enabled" (click)="toggleGroupEnabled(g)" [attr.aria-pressed]="group.enabled !== false" [title]="(group.enabled === false ? 'Enable metric' : 'Disable metric') | translate">{{ (group.enabled === false ? 'Disabled' : 'Enabled') | translate }}</button>
                            <button class="btn btn-outline-secondary" [disabled]="g === 0" (click)="moveGroup(g, -1)" [title]="'Move up' | translate" [attr.aria-label]="'Move up' | translate">↑</button>
                            <button class="btn btn-outline-secondary" [disabled]="g === metricGroups.length - 1" (click)="moveGroup(g, 1)" [title]="'Move down' | translate" [attr.aria-label]="'Move down' | translate">↓</button>
                            <button type="button" class="btn btn-outline-secondary group-copy" (click)="copyGroup(g)" [title]="'Duplicate Group' | translate" [attr.aria-label]="'Duplicate Group' | translate"><i class="fas fa-copy" aria-hidden="true"></i></button>
                            <button type="button" class="btn btn-outline-secondary group-edit" (click)="editGroup(g)" [title]="'Edit' | translate" [attr.aria-label]="'Edit' | translate" [attr.aria-controls]="'group-editor-' + group.id"><i class="fas fa-pen" aria-hidden="true"></i></button>
                        </div>
                    </div>
                    <div class="group-card-preview">
                        <div class="group-main-summary">
                            <span class="member-kind" translate>Main Metric</span>
                            <button type="button" class="member-summary-chip main-summary-chip" (click)="editGroupMember(g, -1)" [title]="'Edit' | translate">
                                <span [style.color]="group.main.color || '#00ff00'"><ng-container *ngTemplateOutlet="metricIcon; context: { $implicit: group.main }"></ng-container></span>
                                {{ group.main.label || group.main.icon || ('Unnamed Metric' | translate) }}
                            </button>
                        </div>
                        <div class="group-child-summary" *ngIf="group.children.length">
                            <span class="member-kind" translate>Child Metric</span>
                            <div class="summary-chips">
                                <button type="button" *ngFor="let child of group.children; let c = index" class="member-summary-chip child-summary-chip" (click)="editGroupMember(g, c)" [title]="'Edit' | translate">
                                    <span [style.color]="child.color || '#00ff00'"><ng-container *ngTemplateOutlet="metricIcon; context: { $implicit: child }"></ng-container></span>
                                    {{ child.label || child.icon || ('Unnamed Metric' | translate) }}
                                </button>
                            </div>
                        </div>
                        <div class="command-box group-command" [title]="group.main.command">{{ group.main.command }}</div>
                    </div>
                    <div class="inline-item-editor" *ngIf="editingGroupId === group.id" [id]="'group-editor-' + group.id">
                        <ng-container *ngTemplateOutlet="itemEditor"></ng-container>
                    </div>
                    <div class="card-delete-actions">
                        <button type="button" class="btn btn-outline-danger btn-sm group-delete" (click)="removeGroup(g)"><i class="fas fa-trash" aria-hidden="true"></i> <span translate>Delete Group</span> · {{ group.label || ('Metric Group' | translate) }} / {{ 'Main Metric' | translate }}: {{ group.main.label || group.main.icon || ('Unnamed Metric' | translate) }}</button>
                    </div>
                </div>
                <div class="list-group-item text-muted p-3" *ngIf="metricGroups.length === 0" translate>No metric groups defined.</div>
            </div>
            <div class="list-group new-item-editor" *ngIf="!editingBuiltinKey && !editingGroupId && currentGroup">
                <div class="list-group-item custom-metric-item p-3"><ng-container *ngTemplateOutlet="itemEditor"></ng-container></div>
            </div>
        </section>

        <aside #editorNavigator class="editor-navigator" *ngIf="editorOpen" aria-label="Metric editor navigation" (keydown)="onEditorKeydown($event)">
            <div class="navigator-header">
                <button type="button" class="navigator-drag" (pointerdown)="startNavigatorDrag($event)" (pointermove)="moveNavigator($event)" (pointerup)="endNavigatorDrag($event)" (pointercancel)="endNavigatorDrag($event)" [title]="'Drag to move' | translate">
                    <span aria-hidden="true">⠿</span><strong class="navigator-title">{{ editorName }}</strong>
                </button>
                <button type="button" class="navigator-reset" (click)="resetNavigatorPosition()" [title]="'Return to right side' | translate" [attr.aria-label]="'Return to right side' | translate">↗</button>
            </div>
            <small translate>Click a label to locate its editor</small>
            <nav class="navigator-members">
                <button type="button" class="navigator-main" (click)="navigateMember(-1)" [class.active]="!currentGroup || currentMetric.id === currentGroup.main.id">
                    <ng-container *ngTemplateOutlet="metricIcon; context: { $implicit: currentGroup ? currentGroup.main : currentMetric }"></ng-container>
                    <span><small>{{ (currentGroup ? 'Main Metric' : 'Metric') | translate }}</small>{{ (currentGroup ? currentGroup.main.label : currentMetric.label) || ('Unnamed Metric' | translate) }}</span>
                </button>
                <button type="button" *ngFor="let child of currentGroup?.children; let c = index" class="navigator-child" (click)="navigateMember(c)" [class.active]="currentMetric.id === child.id" [attr.aria-expanded]="expandedMembers.has(child.id)">
                    <ng-container *ngTemplateOutlet="metricIcon; context: { $implicit: child }"></ng-container>
                    <span><small>{{ 'Child Metric' | translate }} {{c + 1}}</small>{{ child.label || child.icon || ('Unnamed Metric' | translate) }}</span>
                </button>
            </nav>
            <div class="navigator-actions">
                <button type="button" class="btn btn-primary navigator-save" (click)="saveMetric()" [disabled]="!editorValid">{{ 'Save' | translate }} <kbd>Ctrl+S</kbd></button>
                <button type="button" class="btn btn-outline-secondary navigator-close" (click)="requestEditorClose()" translate>Close</button>
            </div>
            <span class="save-notice" role="status" *ngIf="saveNotice">{{saveNotice}}</span>
            <div class="navigator-close-prompt" *ngIf="closePrompt" role="alertdialog" [attr.aria-label]="'Save changes before closing?' | translate">
                <p translate>Save changes before closing?</p>
                <button type="button" class="btn btn-primary save-close" (click)="finishEditorClose(true)" [disabled]="!editorValid" translate>Save and close</button>
                <button type="button" class="btn btn-outline-danger discard-close" (click)="finishEditorClose(false)" translate>Discard and close</button>
                <button type="button" class="btn btn-outline-secondary continue-editing" (click)="closePrompt = false" translate>Continue editing</button>
            </div>
        </aside>

        <ng-template #metricIcon let-metric>
          <span class="configured-icon" [style.color]="metric.color || '#00ff00'">
            <svg *ngIf="getSvgPath(metric.icon)" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path [attr.d]="getSvgPath(metric.icon)"></path></svg>
            <span class="uploaded-icon" *ngIf="metric.icon?.startsWith('data:image/')" [style.mask-image]="iconMask(metric.icon)" [style.-webkit-mask-image]="iconMask(metric.icon)"></span>
            <img *ngIf="isUrl(metric.icon) && !metric.icon?.startsWith('data:image/')" [src]="getSafeIconUrl(metric.icon)" width="18" height="18" alt="" />
            <i *ngIf="isFa(metric.icon)" [class]="getIconClass(metric.icon)" aria-hidden="true"></i>
          </span>
        </ng-template>
        <ng-template #itemEditor>
            <div class="editor-start" id="stats-editor-start"></div>
            <div class="scope-editor border rounded p-3 mb-3">
                <label class="form-label fw-bold" for="stats-scope-mode" translate>Display Scope</label>
                <select id="stats-scope-mode" class="form-select form-select-sm" [ngModel]="scopeMode" (ngModelChange)="setScopeMode($event)">
                    <option value="all" translate>All terminal panes (default)</option>
                    <option value="selected" translate>Selected connections or layouts</option>
                </select>
                <div class="form-text" *ngIf="currentGroup" translate>The entire group shares this scope, including its main metric and children.</div>
                <div class="form-text" *ngIf="scopeMode === 'all'" translate>Show in every supported terminal pane, including new connections and split panes.</div>
                <ng-container *ngIf="scopeMode === 'selected'">
                    <div class="scope-help mt-2" translate>Expand a layout to select its individual panes, even if their original saved connection was deleted.</div>
                    <div class="form-text mb-2" translate>Checking a connection selects every entry with the same connection ID. Unchecking removes only that entry. A layout checkbox selects or clears its own panes.</div>
                    <label class="form-label mt-2" for="stats-scope-search" translate>Find a saved connection or layout</label>
                    <input id="stats-scope-search" class="form-control form-control-sm mb-2" [(ngModel)]="scopeSearch" [placeholder]="'Search by name' | translate">
                    <div class="scope-options" role="group" [attr.aria-label]="'Saved connections and layouts' | translate">
                        <div class="scope-option" *ngFor="let profile of scopeChoices; trackBy: trackScopeChoice" [attr.title]="profile.id" [class.scope-pane]="profile.layoutId" [class.scope-layout]="profile.type === 'split-layout'">
                            <button type="button" class="scope-expand" *ngIf="profile.type === 'split-layout'" (click)="toggleScopeLayout(profile.id)" [attr.aria-expanded]="!collapsedScopeLayouts.has(profile.id)" [attr.aria-label]="(collapsedScopeLayouts.has(profile.id) ? 'Expand layout' : 'Collapse layout') | translate"><i class="fas" [class.fa-chevron-right]="collapsedScopeLayouts.has(profile.id)" [class.fa-chevron-down]="!collapsedScopeLayouts.has(profile.id)" aria-hidden="true"></i></button>
                            <label class="scope-target">
                                <input type="checkbox" class="form-check-input" [checked]="isScopeSelected(profile.id)" [indeterminate]="isScopeIndeterminate(profile.id)" (change)="toggleScopeProfile(profile.id, $any($event.target).checked)">
                                <span class="scope-name"><small class="text-muted" *ngIf="profile.group && !profile.layoutId">{{profile.group}} / </small><small class="scope-pane-number" *ngIf="profile.path">{{paneNumber(profile)}}</small>{{profile.name}}<small class="text-muted ms-2" *ngIf="profile.disambiguator">#{{profile.disambiguator}}</small></span>
                                <span class="badge bg-secondary">{{(profile.layoutId ? 'Layout Pane' : profile.type === 'split-layout' ? 'Saved Layout' : 'Saved Connection') | translate}}</span>
                            </label>
                        </div>
                        <div class="text-muted p-2" *ngIf="scopeChoices.length === 0" translate>No matching saved connections or layouts.</div>
                    </div>
                    <div class="scope-selected mt-2" *ngIf="scopeSelectedProfiles.length">
                        <div class="scope-selection" *ngFor="let profile of scopeSelectedProfiles; trackBy: trackScopeChoice" [class.scope-missing]="profile.missing">
                            <span><small class="text-muted" *ngIf="profile.group">{{profile.group}} / </small>{{profile.name}}</span>
                            <span class="badge bg-warning text-dark" *ngIf="profile.missing" translate>Deleted or unavailable</span>
                            <button type="button" class="btn btn-outline-secondary btn-sm" (click)="removeScopeProfile(profile.id)" [attr.aria-label]="('Remove scope selection' | translate) + ': ' + profile.name">×</button>
                        </div>
                    </div>
                    <div class="text-warning mt-2" *ngIf="scopeSelectedProfiles.length === 0" translate>No targets selected: this item will not appear in any pane. Choose targets or switch explicitly to all panes.</div>
                    <div class="text-warning mt-2" *ngIf="hasMissingScopeProfiles" translate>Missing targets remain selected but cannot match a pane. Remove or replace them; deletion never changes this item to all panes.</div>
                </ng-container>
            </div>
            <ng-container *ngIf="currentGroup">
                <h5 class="mb-3">{{ (editingGroupId || editingBuiltinKey ? 'Edit Group' : 'Add Group') | translate }}</h5>
                <div class="row g-3 mb-3">
                    <div class="col-md-6">
                        <label class="form-label" translate>Group Name</label>
                        <input class="form-control form-control-sm" [(ngModel)]="currentGroup.label">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label" translate>Group Display Mode</label>
                        <select class="form-select form-select-sm" [(ngModel)]="currentGroup.mode">
                            <option value="overview" translate>Overview</option>
                            <option value="carousel" translate>Carousel</option>
                            <option value="static" translate>Static</option>
                        </select>
                    </div>
                    <div class="col-md-6" *ngIf="currentGroup.mode === 'static'">
                        <label class="form-label" translate>Layout Direction</label>
                        <select class="form-select form-select-sm" [(ngModel)]="currentGroup.layout">
                            <option value="horizontal" translate>Horizontal</option>
                            <option value="vertical" translate>Vertical</option>
                        </select>
                    </div>
                    <div class="col-md-6" *ngIf="currentGroup.mode === 'carousel'">
                        <label class="form-label" translate>Carousel Interval (sec)</label>
                        <input type="number" min="1" class="form-control form-control-sm" [(ngModel)]="currentGroup.interval">
                        <div class="form-text" translate>Controls display switching, independently of command refresh intervals.</div>
                    </div>
                    <div class="col-md-6" *ngIf="currentGroup.mode === 'carousel'">
                        <label class="form-label" translate>Empty Carousel Text</label>
                        <input class="form-control form-control-sm" [(ngModel)]="currentGroup.emptyText" [placeholder]="'No available metrics' | translate">
                    </div>
                </div>
                <div class="group-mode-help text-muted mb-3">{{ groupModeHelp(currentGroup.mode) | translate }}</div>
                <div class="group-members mb-3">
                    <section class="group-member group-member-main" [class.member-open]="expandedMembers.has(currentGroup.main.id)" [class.metric-disabled]="currentGroup.main.enabled === false">
                      <div class="member-header">
                        <button type="button" class="member-toggle" (click)="toggleGroupMetric(-1)" [attr.aria-expanded]="expandedMembers.has(currentGroup.main.id)" [attr.aria-controls]="'member-editor-' + currentGroup.main.id">
                            <span class="member-icon" [style.color]="currentGroup.main.color || '#00ff00'"><ng-container *ngTemplateOutlet="metricIcon; context: { $implicit: currentGroup.main }"></ng-container></span>
                            <span class="member-kind" translate>Main Metric</span>
                            <strong>{{ currentGroup.main.label || currentGroup.main.icon || ('Unnamed Metric' | translate) }}</strong>
                            <i class="fas member-chevron" [class.fa-chevron-down]="!expandedMembers.has(currentGroup.main.id)" [class.fa-chevron-up]="expandedMembers.has(currentGroup.main.id)" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="btn btn-outline-secondary btn-sm member-enabled" (click)="toggleMemberEnabled(currentGroup.main)" [attr.aria-pressed]="currentGroup.main.enabled !== false">{{ (currentGroup.main.enabled === false ? 'Disabled' : 'Enabled') | translate }}</button>
                      </div>
                        <div class="member-editor" [attr.data-member-id]="currentGroup.main.id" *ngIf="expandedMembers.has(currentGroup.main.id)" [id]="'member-editor-' + currentGroup.main.id">
                            <ng-container *ngTemplateOutlet="metricFields; context: { $implicit: currentGroup.main }"></ng-container>
                        </div>
                    </section>
                    <section class="group-member group-member-child" *ngFor="let child of currentGroup.children; let c = index" [class.member-open]="expandedMembers.has(child.id)" [class.metric-disabled]="child.enabled === false">
                        <div class="member-header">
                            <button type="button" class="member-toggle" (click)="toggleGroupMetric(c)" [attr.aria-expanded]="expandedMembers.has(child.id)" [attr.aria-controls]="'member-editor-' + child.id">
                                <span class="member-icon" [style.color]="child.color || '#00ff00'"><ng-container *ngTemplateOutlet="metricIcon; context: { $implicit: child }"></ng-container></span>
                                <span class="member-kind">{{ 'Child Metric' | translate }} {{ c + 1 }}</span>
                                <strong>{{ child.label || child.icon || ('Unnamed Metric' | translate) }}</strong>
                                <i class="fas member-chevron" [class.fa-chevron-down]="!expandedMembers.has(child.id)" [class.fa-chevron-up]="expandedMembers.has(child.id)" aria-hidden="true"></i>
                            </button>
                            <div class="btn-group btn-group-sm member-actions">
                                <button type="button" class="btn btn-outline-secondary child-copy" (click)="copyChild(c)" [title]="'Duplicate Child' | translate" [attr.aria-label]="'Duplicate Child' | translate"><i class="fas fa-copy" aria-hidden="true"></i></button>
                                <button type="button" class="btn btn-outline-secondary member-enabled" (click)="toggleMemberEnabled(child)" [attr.aria-pressed]="child.enabled !== false">{{ (child.enabled === false ? 'Disabled' : 'Enabled') | translate }}</button>
                                <button class="btn btn-outline-secondary" [disabled]="c === 0" (click)="moveChild(c, -1)" [title]="'Move up' | translate" [attr.aria-label]="'Move up' | translate">↑</button>
                                <button class="btn btn-outline-secondary" [disabled]="c === currentGroup.children.length - 1" (click)="moveChild(c, 1)" [title]="'Move down' | translate" [attr.aria-label]="'Move down' | translate">↓</button>
                            </div>
                        </div>
                        <div class="member-editor" [attr.data-member-id]="child.id" *ngIf="expandedMembers.has(child.id)" [id]="'member-editor-' + child.id">
                            <ng-container *ngTemplateOutlet="metricFields; context: { $implicit: child }"></ng-container>
                        </div>
                        <div class="card-delete-actions member-delete-actions">
                            <button type="button" class="btn btn-outline-danger btn-sm child-delete" (click)="removeChild(c)"><i class="fas fa-trash" aria-hidden="true"></i> <span translate>Remove Child</span> · {{ currentGroup.label || ('Metric Group' | translate) }} / {{ child.label || child.icon || ('Unnamed Metric' | translate) }}</button>
                        </div>
                    </section>
                    <button class="btn btn-outline-primary add-child-btn" (click)="addChild()"><i class="fas fa-plus" aria-hidden="true"></i> <span translate>Add Child</span></button>
                    <div class="form-text mt-2" translate>Edits to all members are saved together with the group.</div>
                </div>
            </ng-container>
            <ng-container *ngIf="!currentGroup && singleExpanded">
                <h5 class="mb-3">{{ metricEditorTitle | translate }}</h5>
                <ng-container *ngTemplateOutlet="metricFields; context: { $implicit: currentMetric }"></ng-container>
            </ng-container>
            <div class="editor-actions text-end">
                <div class="text-warning text-start mb-2" *ngIf="currentGroup && !isGroupValid()" translate>Every member needs a label or icon and a metric command. Intervals and timeouts must be positive; exit codes must be whole numbers from 0 to 255.</div>
                <button class="btn btn-secondary me-2" (click)="requestEditorClose()" translate>Close</button>
                <button class="btn btn-primary text-white" (click)="saveMetric()" [disabled]="currentGroup ? !isGroupValid() : !isMetricValid(currentMetric)">
                    <i class="fas" [class.fa-plus]="editingIndex === -1 && !currentGroup && !editingBuiltinKey" [class.fa-save]="editingIndex !== -1 || currentGroup || editingBuiltinKey"></i>
                    {{ (currentGroup ? 'Save Group' : (editingBuiltinKey || editingIndex !== -1 ? 'Save' : 'Add')) | translate }}
                </button>
            </div>
        </ng-template>
        <ng-template #metricFields let-metric>
            <div class="row g-3 metric-fields" (focusin)="activateMetric(metric)" (pointerdown)="activateMetric(metric)">
                <div class="col-md-4">
                    <label class="form-label" translate>Label</label>
                    <input type="text" class="form-control form-control-sm" [(ngModel)]="metric.label" placeholder="{{ 'e.g. PostgreSQL (optional if icon set)' | translate }}">
                </div>
                <div class="col-md-8">
                    <label class="form-label" translate>Icon (FontAwesome or custom SVG)</label>
                    <div class="icon-input-wrap position-relative">
                        <div class="input-group input-group-sm">
                            <span class="input-group-text" [style.color]="metric.color || '#00ff00'" *ngIf="metric.icon" style="padding: 0 8px; width: 34px; justify-content: center;">
                                <svg *ngIf="getSvgPath(metric.icon)" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                    <path [attr.d]="getSvgPath(metric.icon)"></path>
                                </svg>
                                <span class="uploaded-icon" *ngIf="metric.icon?.startsWith('data:image/')" [style.mask-image]="iconMask(metric.icon)" [style.-webkit-mask-image]="iconMask(metric.icon)"></span>
                                <img *ngIf="isUrl(metric.icon) && !metric.icon?.startsWith('data:image/')" [src]="getSafeIconUrl(metric.icon)" width="16" height="16" style="object-fit: contain;" />
                                <i *ngIf="isFa(metric.icon)" [class]="getIconClass(metric.icon)"></i>
                            </span>
                            <input type="text"
                                   class="form-control"
                                   [(ngModel)]="metric.icon"
                                   placeholder="{{ 'fa-database, server, redis...' | translate }}">
                            <button type="button"
                                    class="btn btn-outline-secondary icon-picker-toggle"
                                    (click)="toggleIconPicker($event)"
                                    title="{{ 'Choose preset icon' | translate }}">
                                <i class="fas fa-ellipsis-v"></i>
                            </button>
                            <input type="file"
                                   #svgFileInput
                                   accept=".svg,image/svg+xml"
                                   (change)="onSvgFileSelected($event)"
                                   style="display: none;">
                            <button type="button"
                                    class="btn btn-outline-secondary"
                                    (click)="svgFileInput.click()"
                                    title="{{ 'Upload Custom SVG' | translate }}">
                                <i class="fas fa-file-upload me-1"></i> <span translate>SVG</span>
                            </button>
                            <button type="button"
                                    class="btn btn-outline-danger"
                                    *ngIf="metric.icon"
                                    (click)="clearIcon()"
                                    title="{{ 'Remove Icon' | translate }}">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                        <div class="icon-picker-panel" *ngIf="iconPickerOpen && currentMetric === metric" (click)="$event.stopPropagation()">
                            <div class="icon-picker-title" translate>Preset Icons</div>
                            <div class="icon-picker-filters">
                                <input type="search" class="form-control form-control-sm icon-search" [(ngModel)]="iconSearch" [placeholder]="'Search icons by name or purpose' | translate" [attr.aria-label]="'Search icons by name or purpose' | translate">
                                <select class="form-select form-select-sm icon-category" [(ngModel)]="iconCategory" [attr.aria-label]="'Icon category' | translate">
                                    <option value="all" translate>All icon categories</option>
                                    <option *ngFor="let category of iconCategories" [value]="category">{{ category | translate }}</option>
                                </select>
                            </div>
                            <div class="icon-picker-grid">
                                <button type="button"
                                        class="icon-picker-item" [style.color]="metric.color || '#00ff00'"
                                        *ngFor="let preset of filteredIconPresets; trackBy: trackIconPreset"
                                        [class.active]="metric.icon === preset.name"
                                        [title]="(preset.label | translate) + ' (' + preset.name + ')'"
                                        [attr.aria-label]="preset.label | translate"
                                        [attr.aria-pressed]="metric.icon === preset.name"
                                        (click)="selectPresetIcon(preset.name)">
                                    <svg *ngIf="getSvgPath(preset.name)" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
                                        <path [attr.d]="getSvgPath(preset.name)"></path>
                                    </svg>
                                    <i *ngIf="isFa(preset.name)" [class]="getIconClass(preset.name)" aria-hidden="true"></i>
                                    <span class="icon-preset-label">{{ preset.label | translate }}</span>
                                </button>
                            </div>
                            <div class="icon-empty" *ngIf="filteredIconPresets.length === 0" translate>No icons match this search.</div>
                        </div>
                    </div>
                    <div class="form-text text-muted" style="font-size: 11px;">
                        <span translate>Use FontAwesome (ex: database, server, memory) or upload a custom .svg file</span>
                    </div>
                </div>

                <div class="col-md-3">
                    <label class="form-label" translate>Type</label>
                    <select class="form-select form-select-sm" [(ngModel)]="metric.type">
                        <option value="text" translate>Text Value</option>
                        <option value="progress" translate>Progress Bar</option>
                    </select>
                </div>
                <div class="col-md-3">
                    <label class="form-label" translate>Default Color</label>
                    <input type="color" class="form-control form-control-color form-control-sm w-100" [(ngModel)]="metric.color">
                </div>
                <div class="col-md-3" *ngIf="metric.type === 'progress'">
                    <label class="form-label" translate>Max Value</label>
                    <input type="number" class="form-control form-control-sm" [(ngModel)]="metric.maxValue" placeholder="100">
                </div>
                <div class="col-md-3">
                    <label class="form-label" translate>Suffix</label>
                    <input type="text" class="form-control form-control-sm" [(ngModel)]="metric.suffix" [placeholder]="metric.type === 'progress' ? ('e.g. GB (or % if empty)' | translate) : ('e.g. °C, ms' | translate)">
                </div>
                <div class="col-md-3">
                    <label class="form-label" translate>Interval (sec)</label>
                    <input type="number" min="1" class="form-control form-control-sm" [(ngModel)]="metric.interval" placeholder="{{ defaultInterval }}s">
                </div>
                <div class="col-md-3">
                    <label class="form-label" translate>Timeout (sec)</label>
                    <input type="number" min="1" class="form-control form-control-sm" [(ngModel)]="metric.timeout" placeholder="15s">
                </div>
                <div class="col-12 check-command">
                    <label class="form-label" translate>Object Check Command (optional)</label>
                    <textarea class="form-control form-control-sm font-monospace" rows="2" [(ngModel)]="metric.checkCommand" [placeholder]="metric.checkMode === 'output' ? 'mountpoint -q /data2 &amp;&amp; echo exists' : 'mountpoint -q /data2'"></textarea>
                    <div class="form-text" translate>Leave empty to run the metric directly. A failed check prevents both metric and detail commands from running.</div>
                </div>
                <ng-container *ngIf="metric.checkCommand && metric.checkCommand.trim()">
                    <div class="col-md-4">
                        <label class="form-label" translate>Compare</label>
                        <select class="form-select form-select-sm" [(ngModel)]="metric.checkMode">
                            <option value="output" translate>Output Text</option>
                            <option value="exitCode" translate>Exit Code</option>
                        </select>
                    </div>
                    <div class="col-md-4">
                        <label class="form-label" translate>Expected Value</label>
                        <input class="form-control form-control-sm" [(ngModel)]="metric.checkExpected" [placeholder]="metric.checkMode === 'output' ? 'exists' : '0'">
                    </div>
                    <div class="col-md-4">
                        <label class="form-label" translate>Check Failure Text</label>
                        <input class="form-control form-control-sm" [(ngModel)]="metric.unavailableText" [placeholder]="'Unavailable' | translate">
                    </div>
                    <div class="col-12 form-text" translate>Output text is compared exactly after trimming surrounding whitespace. Exit code 0 usually means success.</div>
                </ng-container>
                <div class="col-12 metric-command">
                    <label class="form-label" translate>Command (Shell)</label>
                    <div class="input-group input-group-sm">
                        <textarea class="form-control font-monospace"
                                  rows="2"
                                  [(ngModel)]="metric.command"
                                  placeholder="e.g. mongosh ... or redis-cli info | grep used_memory_human"></textarea>
                    </div>
                    <div class="form-text text-muted" style="font-size: 11px;" translate>
                        Command executed on the server. The output (number or text) will be displayed.
                    </div>
                </div>

                <div class="col-12 detail-command">
                    <label class="form-label" translate>Detail Command (optional)</label>
                    <textarea class="form-control form-control-sm font-monospace" rows="2" [(ngModel)]="metric.detailCommand"></textarea>
                    <div class="form-text" translate>Click to expand details; click again or move away to close. Single labels use a popup; groups follow their display mode. Leave empty for no extra information.</div>
                </div>
                <div class="col-12 unavailable-visibility">
                    <label class="form-check">
                        <input class="form-check-input visible-unavailable" type="checkbox" [ngModel]="metric.visibleWhenUnavailable !== false" (ngModelChange)="setUnavailableVisibility($event)">
                        <span class="form-check-label" translate>Show this label when its check fails</span>
                    </label>
                    <div class="form-text" translate>Enabled by default. Turning this off hides the label in every display mode and also removes it from the carousel.</div>
                </div>
                <div class="col-12" *ngIf="currentGroup && metric.id !== currentGroup.main.id">
                    <label class="form-check">
                        <input class="form-check-input carousel-unavailable" type="checkbox" [(ngModel)]="metric.showWhenUnavailable" [disabled]="metric.visibleWhenUnavailable === false">
                        <span class="form-check-label" translate>Keep in carousel when its check fails</span>
                    </label>
                    <div class="form-text" translate>When the failed label remains visible, this option controls whether it participates in the carousel. Static and expanded views retain it.</div>
                </div>

                <!-- 条件颜色规则区域 -->
                <div class="col-md-12 mt-3">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <label class="form-label mb-0 fw-bold" translate>Conditional Color Rules</label>
                        <button type="button" class="btn btn-outline-primary btn-sm" (click)="addColorRule()">
                            <i class="fas fa-plus me-1"></i> <span translate>Add Rule</span>
                        </button>
                    </div>
                    <div class="text-muted mb-2" style="font-size: 12px;" translate>
                        Color rules are checked from top to bottom. The first matching rule determines the color.
                    </div>
                    <div *ngIf="metric.valueFormat === 'disk-io-rate'" class="form-text io-color-help mb-2" translate>
                        I/O color rules use percent of reference bandwidth (80 orange, 95 red); the displayed value remains MB/s. This is a throughput reference, not disk health or utilization.
                    </div>

                    <div *ngIf="!metric.colorRules || metric.colorRules.length === 0" class="text-muted fst-italic p-2 border rounded text-center" style="font-size: 12px;">
                        <span translate>No conditional rules defined. Default color will always be used.</span>
                    </div>

                    <div class="border rounded p-2 mb-2 bg-light bg-opacity-10" *ngFor="let rule of metric.colorRules; let rIndex = index">
                        <div class="row g-2 align-items-center">
                            <div class="col-md-4">
                                <select class="form-select form-select-sm" [(ngModel)]="rule.operator">
                                    <option value="==" translate>Equals (==)</option>
                                    <option value="!=" translate>Not Equals (!=)</option>
                                    <option value=">" translate>Greater than (&gt;)</option>
                                    <option value=">=" translate>Greater or Equal (&gt;=)</option>
                                    <option value="<" translate>Less than (&lt;)</option>
                                    <option value="<=" translate>Less or Equal (&lt;=)</option>
                                    <option value="contains" translate>Contains</option>
                                    <option value="not_contains" translate>Not Contains</option>
                                    <option value="starts_with" translate>Starts With</option>
                                    <option value="regex" translate>Regex Match</option>
                                </select>
                            </div>
                            <div class="col-md-4">
                                <input type="text" class="form-control form-control-sm" [(ngModel)]="rule.value" placeholder="{{ 'Threshold / Value' | translate }}">
                            </div>
                            <div class="col-md-3">
                                <input type="color" class="form-control form-control-color form-control-sm w-100" [(ngModel)]="rule.color">
                            </div>
                            <div class="col-md-1 text-end">
                                <button type="button" class="btn btn-outline-danger btn-sm" (click)="removeColorRule(rIndex)">
                                    <i class="fas fa-times"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        </ng-template>
    `,
    styles: [`
        :host { display: block; width: 100%; min-width: 0; box-sizing: border-box; }
        .editor-navigator { position: fixed; width: clamp(220px, 20vw, 300px); max-width: calc(100vw - 16px); max-height: min(720px, calc(100vh - 64px)); display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 2px solid var(--stats-card-border); border-radius: 10px; background: var(--stats-card-bg); color: var(--stats-field-fg); z-index: 1050; box-sizing: border-box; overflow: hidden; box-shadow: 0 8px 28px #0006; }
        .navigator-header { display: flex; gap: 6px; flex: 0 0 auto; align-items: center; }
        .navigator-drag, .navigator-reset { border: 0; background: transparent; color: inherit; padding: 4px; }
        .navigator-drag { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; text-align: left; cursor: grab; touch-action: none; user-select: none; }
        .navigator-drag:active { cursor: grabbing; }
        .navigator-reset { cursor: pointer; font-size: 18px; }
        .navigator-title { overflow-wrap: anywhere; }
        .navigator-members { display: flex; flex: 1 1 auto; flex-direction: column; gap: 6px; overflow: auto; min-height: 0; }
        .navigator-members button { flex: 0 0 auto; }
        .navigator-actions, .navigator-close-prompt, .save-notice, .editor-navigator > small { flex-shrink: 0; }
        .navigator-members button { display: flex; align-items: center; gap: 10px; text-align: left; border: 1px solid var(--stats-field-border); border-radius: 5px; padding: 8px; background: var(--stats-field-bg); color: inherit; }
        .navigator-members button.active { border-color: var(--stats-focus); }
        .navigator-members button > span { min-width: 0; overflow-wrap: anywhere; }
        .navigator-members small { display: block; color: var(--stats-field-muted); font-size: 11px; }
        .navigator-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .editor-navigator .btn { border: 1px solid var(--stats-field-border); padding: 6px 9px; border-radius: 5px; font-size: 12px; background: var(--stats-field-bg); color: inherit; cursor: pointer; }
        .editor-navigator .btn-primary { background: #246dc6; border-color: #579eff; color: white; }
        .editor-navigator .btn:disabled { opacity: .55; cursor: default; }
        .navigator-close-prompt { border-top: 1px solid var(--stats-field-border); padding-top: 10px; }
        .navigator-close-prompt button { margin-bottom: 6px; width: 100%; white-space: normal; }
        .save-notice { color: var(--stats-field-muted); font-size: 12px; }
        .group-member, .editor-start { scroll-margin-top: 24px; }
        .configured-icon { display: inline-flex; align-items: center; flex: 0 0 auto; }
        .uploaded-icon { display: inline-block; width: 18px; height: 18px; background: currentColor; mask: center / contain no-repeat; -webkit-mask: center / contain no-repeat; }
        .card-delete-actions .btn { white-space: normal; overflow-wrap: anywhere; text-align: left; }
        @media (max-width: 760px) {
            .group-card-header, .member-header { flex-wrap: wrap; }
        }
        :host {
            --stats-field-bg: #242e3c;
            --stats-field-border: #596a82;
            --stats-field-hover: #8194ad;
            --stats-field-fg: var(--theme-fg, var(--bs-body-color, #e5ecf5));
            --stats-field-muted: #b4c0d0;
            --stats-field-placeholder: #9caec2;
            --stats-focus: #579eff;
            --stats-card-border: #7389a5;
            --stats-section-accent: #7389a5;
            --stats-section-bg: #1d222b;
            --stats-card-bg: #191d24;
        }
        @supports (color: color-mix(in srgb, white, black)) {
            :host {
                --stats-field-bg: color-mix(in srgb, var(--theme-bg, var(--bs-body-bg, #181c23)) 82%, #7897bf 18%);
                --stats-field-border: color-mix(in srgb, var(--stats-field-fg) 40%, var(--theme-bg, var(--bs-body-bg, #181c23)) 60%);
                --stats-field-hover: color-mix(in srgb, var(--stats-field-fg) 58%, var(--theme-bg, var(--bs-body-bg, #181c23)) 42%);
                --stats-field-muted: color-mix(in srgb, var(--stats-field-fg) 78%, var(--theme-bg, var(--bs-body-bg, #181c23)) 22%);
                --stats-field-placeholder: color-mix(in srgb, var(--stats-field-fg) 65%, var(--theme-bg, var(--bs-body-bg, #181c23)) 35%);
                --stats-card-border: color-mix(in srgb, var(--stats-field-fg) 52%, var(--theme-bg, var(--bs-body-bg, #181c23)) 48%);
                --stats-section-bg: color-mix(in srgb, var(--theme-bg, var(--bs-body-bg, #181c23)) 95%, var(--stats-section-accent) 5%);
                --stats-card-bg: color-mix(in srgb, var(--theme-bg, var(--bs-body-bg, #181c23)) 90%, var(--stats-section-accent) 10%);
            }
        }
        .form-control, .form-select, .input-group-text {
            color: var(--stats-field-fg);
            background-color: var(--stats-field-bg);
            border: 1px solid var(--stats-field-border);
            border-radius: 6px;
            min-height: 36px;
            box-shadow: inset 0 1px 2px #00000012;
            transition: border-color .15s, box-shadow .15s;
        }
        .form-control:hover, .form-select:hover { border-color: var(--stats-field-hover); }
        .form-control:focus, .form-select:focus {
            color: var(--stats-field-fg);
            background-color: var(--stats-field-bg);
            border-color: var(--stats-focus);
            outline: 2px solid #579eff55;
            outline-offset: 1px;
            box-shadow: 0 0 0 3px #579eff1a;
        }
        .form-control::placeholder { color: var(--stats-field-placeholder); opacity: 1; }
        .form-select option { color: var(--stats-field-fg); background-color: var(--stats-field-bg); }
        .form-label, .form-check-label { color: var(--stats-field-fg); }
        .metric-fields .form-text, .scope-editor .form-text, .scope-help, .group-mode-help,
        .scope-option .text-muted, .scope-selection .text-muted, .member-kind {
            color: var(--stats-field-muted) !important;
            opacity: 1;
        }
        .metric-fields .text-muted { color: var(--stats-field-muted) !important; opacity: 1; }
        .form-check-input {
            border: 1px solid var(--stats-field-border);
            background-color: var(--stats-field-bg);
            accent-color: var(--stats-focus);
        }
        .form-check-input:checked { border-color: #3d8beb; background-color: #2877d6; }
        .form-check-input:focus-visible { outline: 2px solid var(--stats-focus); outline-offset: 2px; }
        .form-control:disabled, .form-select:disabled { opacity: .6; }
        .check-command textarea { border-left: 3px solid #aa9660; }
        .metric-command textarea { border-left: 3px solid #709bd6; }
        .detail-command textarea { border-left: 3px solid #679e99; }
        .check-command textarea:focus, .metric-command textarea:focus, .detail-command textarea:focus { border-color: var(--stats-focus); }
        .scope-editor { background-color: #7897bf0b; border-color: var(--stats-field-border) !important; }
        .scope-options { background-color: var(--stats-field-bg); border-color: var(--stats-field-border) !important; }
        .scope-option { border-color: var(--stats-field-border); }
        .scope-option:hover { background-color: #7897bf20; }
        .param-input { width: 80px; text-align: right; }
        .user-select-none { user-select: none; }
        .opacity-50 { opacity: 0.5; }
        .separator { height: 1px; background: rgba(0,0,0,0.1); margin: 20px 0; }
        .white-space-nowrap { white-space: nowrap; }
        .add-preset-btn { width: 12%; justify-content: center; }
        .submit-own-preset-btn { color: #00ffc8ff; text-decoration: none; }
        .submit-own-preset-btn:hover { color: #00daaaff; text-decoration: underline; }
        .settings-section { border: 2px solid var(--stats-section-accent); border-left-width: 5px; border-radius: 12px; padding: 20px; background: var(--stats-section-bg); }
        .single-labels-section { --stats-section-accent: #5f95d6; }
        .metric-groups-section { --stats-section-accent: #4e9a90; }
        .preset-library { --stats-section-accent: #9985c8; }
        .settings-section > h4, .settings-section > .preset-library-header, .settings-section > .d-flex:first-child { margin-bottom: 12px; }
        .custom-metric-item, .settings-section .custom-metric-item { border: 2px solid var(--stats-card-border); border-radius: 9px; transition: border-color 0.2s ease; }
        .custom-metric-item:hover, .custom-metric-item:focus-within { border-color: var(--stats-section-accent); }
        .metric-disabled { border-style: dashed !important; }
        .metric-enabled[aria-pressed="true"], .group-enabled[aria-pressed="true"], .member-enabled[aria-pressed="true"] { color: #70c7a0; border-color: #598c75; }
        .member-enabled { flex-shrink: 0; }
        .settings-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
        .settings-heading h3 { margin: 0; }
        .tutorial-button { color: #fff; background: #175cb8; border: 2px solid #7abaff; font-weight: 700; padding: 9px 16px; box-shadow: 0 0 0 2px #175cb833; }
        .tutorial-button:hover, .tutorial-button:focus-visible { color: #fff; background: #216fd0; outline: 2px solid #b4d9ff; outline-offset: 2px; }
        .builtin-header, .preset-library-header, .preset-card-header { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
        .builtin-actions { margin-left: auto; }
        .preset-library-header { justify-content: space-between; }
        .preset-list { max-height: 420px; overflow-y: auto; padding: 2px; }
        .preset-add { margin-left: auto; }
        .preset-description { margin-top: 10px; font-size: 13px; color: var(--stats-field-muted); }
        .preset-lab-badge { color: var(--stats-field-fg); background: #ffa50020; border: 1px solid #ffa500; }
        .preset-lab-only .preset-description { color: var(--stats-field-fg); border-left: 3px solid #ffa500; padding-left: 10px; }
        .preset-targets, .preset-source { font-size: 12px; color: var(--stats-field-muted); }
        .preset-message { font-size: 13px; color: var(--stats-field-muted); }
        .preset-message.preset-error { color: #ef8f95; border-left: 3px solid #ef8f95; padding: 8px 10px; }
        .preset-github-source { font-size: 12px; color: var(--stats-field-muted); margin-bottom: 12px; overflow-wrap: anywhere; }
        .preset-source-link { border: 0; background: transparent; color: var(--stats-field-fg); text-decoration: underline; padding: 0; text-align: left; }
        .preset-source-link:focus-visible { outline: 2px solid var(--stats-focus); outline-offset: 3px; }
        .builtin-enabled[aria-pressed="true"] { color: #70c7a0; border-color: #598c75; }
        .custom-metric-item { background: var(--stats-card-bg); padding: 18px !important; margin-bottom: 12px !important; }
        .custom-metric-item strong { font-size: 16px !important; }
        .custom-metric-item .badge { font-size: 12px; padding: 5px 8px; border-radius: 7px; }
        .command-box { font-size: 13px !important; line-height: 1.5 !important; }
        h4 { font-size: 22px; font-weight: 650; }
        h5 { font-size: 18px; }
        .group-card-header { display: flex; align-items: center; gap: 14px; }
        .group-card-heading { min-width: 0; flex: 1; display: flex; gap: 12px; align-items: center; color: inherit; text-align: left; }
        .member-toggle:focus-visible { outline: 2px solid #5299ff; outline-offset: 3px; border-radius: 5px; }
        .group-card-icon, .member-icon { display: inline-flex; justify-content: center; align-items: center; width: 20px; flex: 0 0 20px; font-size: 18px; }
        .group-summary { display: flex; flex: 1; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
        .group-count { background: rgba(128,128,128,.16); color: inherit; font-weight: 500; }
        .group-card-actions { flex: 0 0 auto; }
        .group-card-preview { margin: 14px 0 0 32px; }
        .group-main-summary { display: flex; align-items: center; gap: 10px; }
        .member-kind { font-size: 13px; color: #929ba7; font-weight: 500; white-space: nowrap; }
        .group-command { padding: 10px 12px; background: rgba(0,0,0,.3); border: 1px solid rgba(128,128,128,.12); border-radius: 6px; font-family: monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 62px; overflow: hidden; color: #929ba7; }
        .group-child-summary { display: flex; align-items: flex-start; gap: 10px; margin-top: 8px; padding-left: 16px; border-left: 2px solid rgba(128,128,128,.35); }
        .group-child-summary > .member-kind { padding-top: 7px; }
        .summary-chips { display: flex; flex: 1; flex-wrap: wrap; gap: 7px; min-width: 0; }
        .member-summary-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 5px 10px; background: rgba(128,128,128,.1); color: inherit; border: 2px solid var(--stats-card-border); border-radius: 5px; font-size: 14px; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
        .member-summary-chip > span { display: inline-flex; flex-shrink: 0; }
        .member-summary-chip:hover { border-color: var(--stats-focus); background: rgba(49,118,216,.14); }
        .member-summary-chip:focus-visible { outline: 2px solid var(--stats-focus); outline-offset: 3px; }
        .group-card-preview > .group-command { margin-top: 12px; }
        .card-delete-actions { display: flex; justify-content: flex-end; border-top: 1px solid rgba(128,128,128,.25); margin-top: 14px; padding-top: 10px; }
        .card-delete-actions .btn { display: inline-flex; align-items: center; gap: 6px; }
        .member-delete-actions { margin: 0 12px; padding: 8px 0; }
        .inline-item-editor { border-top: 1px solid rgba(128,128,128,.2); margin-top: 18px; padding-top: 18px; cursor: default; user-select: text; }
        .group-members { display: flex; flex-direction: column; gap: 10px; }
        .group-member { border: 2px solid var(--stats-card-border); border-radius: 8px; background: var(--stats-card-bg); }
        .group-member-child { margin-left: 26px; width: calc(100% - 26px); }
        .group-member.member-open { border-color: var(--stats-focus); }
        .member-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-right: 10px; }
        .member-toggle { min-width: min(240px, 100%); flex: 1 1 240px; display: flex; align-items: center; gap: 10px; width: 100%; border: 0; border-radius: 8px; padding: 14px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
        .member-toggle .member-kind { white-space: nowrap; }
        .member-toggle strong { min-width: 0; overflow-wrap: anywhere; }
        .member-open > .member-toggle, .member-open > .member-header { background: rgba(49,118,216,.12); }
        .member-chevron { margin-left: auto; flex-shrink: 0; font-size: 12px; color: #929ba7; }
        .member-actions { flex-shrink: 0; }
        .member-editor { border-top: 1px solid rgba(128,128,128,.2); padding: 18px; }
        .add-child-btn { align-self: flex-start; margin-left: 26px; }
        .editor-actions { margin-top: 18px; padding-top: 16px; border-top: 1px solid rgba(128,128,128,.2); }
        .metric-fields .form-control, .metric-fields .form-select { font-size: 14px; }
        .metric-fields textarea { min-height: 72px; line-height: 1.5; }
        .metric-fields .form-text { font-size: 13px !important; line-height: 1.5; }
        .group-mode-help { font-size: 14px; line-height: 1.5; }
        @media (max-width: 600px) {
            .settings-section { padding: 12px; }
            .group-card-header { flex-wrap: wrap; }
            .group-card-preview { margin-left: 0; }
            .group-member-child { margin-left: 16px; width: calc(100% - 16px); }
            .member-toggle { flex-wrap: wrap; gap: 6px; padding: 10px; }
            .member-editor { padding: 12px; }
        }
        .form-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500; }
        .icon-input-wrap { position: relative; }
        .icon-picker-panel {
            margin-top: 10px;
            padding: 12px;
            border-radius: 8px;
            border: 1px solid var(--stats-field-border);
            background: var(--theme-bg, var(--bs-body-bg, #1e1e1e));
        }
        .icon-picker-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--stats-field-fg);
            margin-bottom: 10px;
        }
        .icon-picker-filters { display: grid; grid-template-columns: minmax(0, 1fr) 130px; gap: 8px; margin-bottom: 10px; }
        .icon-picker-filters .form-control, .icon-picker-filters .form-select { min-width: 0; font-size: 13px; }
        .icon-picker-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
            gap: 8px;
            max-height: 282px;
            overflow-y: auto;
            padding: 3px;
        }
        .icon-picker-item {
            min-width: 0;
            min-height: 70px;
            border-radius: 6px;
            border: 1px solid var(--stats-field-border);
            background: var(--stats-field-bg);
            color: var(--stats-field-fg);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 7px;
            cursor: pointer;
            padding: 10px 6px;
        }
        .icon-picker-item svg, .icon-picker-item i { flex-shrink: 0; font-size: 22px; }
        .icon-preset-label { font-size: 12px; font-weight: 500; line-height: 1.3; overflow-wrap: anywhere; text-align: center; }
        .icon-picker-item:hover { border-color: var(--stats-field-hover); }
        .icon-picker-item.active { border-color: var(--stats-focus); box-shadow: inset 0 0 0 1px var(--stats-focus); background: #3d8beb26; }
        .icon-picker-item:focus-visible { outline: 2px solid var(--stats-focus); outline-offset: 1px; }
        .icon-empty { padding: 18px 8px; text-align: center; color: var(--stats-field-muted); font-size: 13px; }
        @media (max-width: 600px) { .icon-picker-filters { grid-template-columns: minmax(0, 1fr); } }
        .scope-help { font-size: 13px; }
        .scope-options { max-height: 360px; overflow-y: auto; border: 1px solid rgba(128,128,128,.3); border-radius: 4px; }
        .scope-option { display: flex; align-items: center; gap: 9px; padding: 8px 10px; cursor: pointer; border-bottom: 1px solid rgba(128,128,128,.15); }
        .scope-option:last-child { border-bottom: 0; }
        .scope-option:hover { background: rgba(128,128,128,.08); }
        .scope-option .form-check-input { flex: 0 0 auto; margin: 0; }
        .scope-target { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; margin: 0; cursor: pointer; }
        .scope-option.scope-pane { padding-left: 42px; border-left: 2px solid #719bc9; }
        .scope-layout { background: #7897bf15; font-weight: 600; }
        .scope-expand { border: 0; background: transparent; color: inherit; padding: 2px; width: 18px; flex: 0 0 18px; }
        .scope-expand:focus-visible { outline: 2px solid #71b7ff; }
        .scope-pane-number { display: inline-block; min-width: 28px; margin-right: 6px; opacity: .75; font-variant-numeric: tabular-nums; }
        .scope-name { flex: 1 1 auto; overflow-wrap: anywhere; }
        .scope-selected { display: flex; flex-wrap: wrap; gap: 6px; }
        .scope-selection { display: inline-flex; align-items: center; gap: 6px; border: 1px solid rgba(128,128,128,.3); border-radius: 4px; padding: 3px 4px 3px 8px; }
        .scope-selection .btn { padding: 0 5px; }
        .scope-missing { border-color: #bf974a; }
        :host-context(.theme-dark) .separator { background: rgba(255,255,255,0.1); }
    `]
})
export class ServerStatsSettingsComponent implements AfterViewInit, AfterViewChecked, OnDestroy {
    @ViewChild('editorNavigator') navigatorRef?: ElementRef<HTMLElement>;
    private navigatorPortal: HTMLElement | null = null;
    private navigatorPosition: { left: number; top: number } | null = null;
    private navigatorDrag: { pointerId: number; x: number; y: number; handle: HTMLElement } | null = null;
    private settingsBody: HTMLElement | null = null;
    private bodyStyles: { name: string; value: string; priority: string }[] = [];
    private navigatorVisibilityObserver: MutationObserver | null = null;
    private navigatorAncestors: HTMLElement[] = [];

    private watchNavigatorOwner() {
        // Keep watching the original containers while Tabby detaches a cached
        // view, so reinserting it into the same container is observed as well.
        if (!this.element?.nativeElement.isConnected) return;
        const ancestors: HTMLElement[] = [];
        for (let node = this.element?.nativeElement; node; node = node.parentElement) ancestors.push(node);
        if (ancestors.length === this.navigatorAncestors.length && ancestors.every((node, i) => node === this.navigatorAncestors[i])) return;
        this.navigatorVisibilityObserver?.disconnect();
        this.navigatorAncestors = ancestors;
        this.navigatorVisibilityObserver ??= new MutationObserver(() => {
            this.watchNavigatorOwner();
            this.syncNavigatorVisibility();
        });
        for (const node of ancestors) this.navigatorVisibilityObserver.observe(node, {
            attributes: true, attributeFilter: ['class', 'style', 'hidden'], childList: true,
        });
    }

    private syncNavigatorVisibility() {
        const panel = this.navigatorPortal, owner = this.element?.nativeElement;
        if (!panel || !owner) return;
        // Tabby moves inactive tabs to left:-1000%; they still have layout boxes.
        const owningTab = owner.closest('.content-tab');
        const visible = (!owningTab || owningTab.classList.contains('content-tab-active')) &&
            owner.isConnected && owner.getClientRects().length > 0 && getComputedStyle(owner).visibility !== 'hidden';
        panel.style.display = visible ? '' : 'none';
        if (!visible) this.navigatorDrag = null;
        else this.positionNavigator();
    }

    ngAfterViewInit() {
        this.watchNavigatorOwner();
        // Tabby caps every settings provider at 600px. Widen only this provider's
        // container, then restore it when navigating to another settings page.
        this.settingsBody = this.element?.nativeElement.closest('settings-tab-body') || null;
        if (this.settingsBody) {
            this.bodyStyles = ['min-width', 'max-width', 'width'].map(name => ({ name, value: this.settingsBody!.style.getPropertyValue(name), priority: this.settingsBody!.style.getPropertyPriority(name) }));
            this.settingsBody.style.minWidth = '640px';
            this.settingsBody.style.maxWidth = '1440px';
            this.settingsBody.style.width = '100%';
        }
    }

    ngAfterViewChecked() {
        const panel = this.navigatorRef?.nativeElement || null;
        if (this.navigatorPortal && this.navigatorPortal !== panel) this.navigatorPortal.remove();
        if (!panel) { this.navigatorPortal = null; this.navigatorDrag = null; return; }
        if (panel.parentElement !== document.body) {
            const theme = getComputedStyle(this.element.nativeElement);
            for (const name of ['--stats-field-bg', '--stats-field-border', '--stats-field-fg', '--stats-field-muted', '--stats-focus', '--stats-card-border', '--stats-card-bg']) panel.style.setProperty(name, theme.getPropertyValue(name));
            panel.style.fontFamily = theme.fontFamily;
            document.body.appendChild(panel);
        }
        this.navigatorPortal = panel;
        this.watchNavigatorOwner();
        this.syncNavigatorVisibility();
    }

    @HostListener('window:resize')
    positionNavigator() {
        const panel = this.navigatorPortal;
        if (!panel || panel.style.display === 'none') return;
        const { width, height } = panel.getBoundingClientRect();
        const desired = this.navigatorPosition || { left: window.innerWidth - width - 16, top: (window.innerHeight - height) / 2 };
        const left = Math.max(8, Math.min(desired.left, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(desired.top, window.innerHeight - height - 8));
        panel.style.left = `${left}px`; panel.style.top = `${top}px`;
        if (this.navigatorPosition) this.navigatorPosition = { left, top };
    }

    startNavigatorDrag(event: PointerEvent) {
        if (event.button !== 0 || !this.navigatorPortal) return;
        const bounds = this.navigatorPortal.getBoundingClientRect();
        const handle = event.currentTarget as HTMLElement;
        this.navigatorDrag = { pointerId: event.pointerId, x: event.clientX - bounds.left, y: event.clientY - bounds.top, handle };
        this.navigatorPosition = { left: bounds.left, top: bounds.top };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault(); event.stopPropagation();
    }
    moveNavigator(event: PointerEvent) {
        if (!this.navigatorDrag || event.pointerId !== this.navigatorDrag.pointerId) return;
        this.navigatorPosition = { left: event.clientX - this.navigatorDrag.x, top: event.clientY - this.navigatorDrag.y };
        this.positionNavigator(); event.preventDefault(); event.stopPropagation();
    }
    endNavigatorDrag(event: PointerEvent) {
        if (this.navigatorDrag?.pointerId !== event.pointerId) return;
        if (this.navigatorDrag.handle.hasPointerCapture(event.pointerId)) this.navigatorDrag.handle.releasePointerCapture(event.pointerId);
        this.navigatorDrag = null;
    }
    resetNavigatorPosition() { this.navigatorPosition = null; this.positionNavigator(); }
    ngOnDestroy() {
        this.navigatorVisibilityObserver?.disconnect();
        this.navigatorVisibilityObserver = null; this.navigatorAncestors = [];
        this.navigatorPortal?.remove(); this.navigatorPortal = null; this.navigatorDrag = null;
        this.cancelEdit(); // Closing the owning settings view discards its drafts.
        for (const item of this.bodyStyles) this.settingsBody?.style.setProperty(item.name, item.value, item.priority);
    }
    defaultMetric: Partial<CustomMetric> = {
        type: 'text',
        color: '#00ff00',
        maxValue: 100,
        suffix: '',
        icon: '',
        interval: undefined,
        timeout: undefined,
        colorRules: [],
        checkCommand: '',
        checkMode: 'output',
        checkExpected: '',
        unavailableText: '',
        detailCommand: '',
        enabled: true,
        visibleWhenUnavailable: true,
        showWhenUnavailable: true
    };
    currentMetric: Partial<CustomMetric> = { ...this.defaultMetric, colorRules: [] };
    editingIndex = -1;
    newSingleOpen = false;
    editingBuiltinKey: BuiltinMetricKey | null = null;
    get builtinKeys(): BuiltinMetricKey[] { return normalizeBuiltinOrder(this.config.store.plugin.serverStats.builtinOrder); }

    moveBuiltin(key: BuiltinMetricKey, direction: number) {
        const order = this.builtinKeys;
        const index = order.indexOf(key);
        const next = index + direction;
        if (index < 0 || next < 0 || next >= order.length) return;
        [order[index], order[next]] = [order[next], order[index]];
        this.config.store.plugin.serverStats.builtinOrder = order;
        this.save();
    }
    currentGroup: CustomMetricGroup | null = null;
    editingGroupId: string | null = null;
    editingChildIndex = -1;
    expandedMembers = new Set<string>();
    // Retain the selected-member API; expansion is independent for each member.
    get expandedMemberId(): string | null { return this.expandedMembers.has(this.currentMetric.id) ? this.currentMetric.id : null; }
    set expandedMemberId(id: string | null) { if (id) this.expandedMembers.add(id); else this.expandedMembers.clear(); }
    singleExpanded = true;
    closePrompt = false;
    saveNotice = '';
    get editorOpen(): boolean { return !!(this.currentGroup || this.editingBuiltinKey || this.editingIndex >= 0 || this.newSingleOpen); }
    get editorName(): string { return this.currentGroup?.label || this.currentGroup?.main.label || this.currentMetric.label || this.uiText('Unnamed Metric'); }
    get editorValid(): boolean { return this.currentGroup ? this.isGroupValid() : this.isMetricValid(this.currentMetric); }
    activateMetric(metric: Partial<CustomMetric>) {
        if (this.currentMetric !== metric) this.iconPickerOpen = false;
        this.currentMetric = metric;
        this.editingChildIndex = this.currentGroup?.children.findIndex(child => child.id === metric.id) ?? -1;
    }
    requestEditorClose() { this.closePrompt = true; }
    finishEditorClose(save: boolean) { if (save && !this.editorValid) return; if (save) this.saveMetric(true); else this.cancelEdit(); }
    navigateMember(index = -1) {
        if (this.currentGroup) this.selectGroupMetric(index);
        else this.singleExpanded = true;
        this.scrollToEditor(this.currentGroup ? 'member-editor-' + this.currentMetric.id : 'stats-editor-start');
    }
    private scrollToEditor(id: string) {
        // Wait for Angular to insert the fields, then place their heading near
        // the top of the actual scroll container instead of its bottom edge.
        if (typeof document === 'undefined') return;
        setTimeout(() => {
            const owner = this.element?.nativeElement;
            if (!owner?.isConnected) return;
            // Cached settings instances can contain the same metric IDs.
            const editor = Array.from(owner.querySelectorAll<HTMLElement>('[id]')).find(node => node.id === id);
            (editor?.closest('.group-member') || editor)?.scrollIntoView({ block: 'start', behavior: 'auto' });
        });
    }
    @HostListener('keydown', ['$event'])
    onEditorKeydown(event: KeyboardEvent) {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's' || !this.editorOpen) return;
        event.preventDefault(); event.stopPropagation();
        if (this.editorValid) this.saveMetric();
        else this.saveNotice = this.uiText('Complete the required fields before saving.');
    }
    private afterSave(close = false) {
        if (close) { this.cancelEdit(); return; }
        this.expandedMembers.delete(this.currentMetric.id);
        this.singleExpanded = false;
        this.closePrompt = false;
        this.saveNotice = this.uiText('Saved');
    }
    draggedIndex: number | null = null;
    isDragging = false;
    iconPickerOpen = false;
    iconPresets: IconPresetChoice[] = POPULAR_ICON_PRESETS;
    iconSearch = '';
    iconCategory = 'all';
    scopeSearch = '';
    collapsedScopeLayouts = new Set<string>();

    // 预设相关
    presets: MetricPreset[] = getBundledPresets();
    loadingPresets = false;
    fetchError = false;
    presetSearch = '';
    presetMessage = '';
    presetMissingNames: string[] = [];

    constructor(
        private platform: PlatformService,
        public config: ConfigService,
        private sanitizer: DomSanitizer,
        private element: ElementRef<HTMLElement> = null
    ) {
        const conf = this.config.store.plugin.serverStats;
        const legacyChanged = migrateLegacyBuiltinConfig(conf);
        if (migrateDiskIoChecks(conf) || legacyChanged) this.config.save();
    }

    get scopeOwner(): { displayScope?: DisplayScope } {
        return this.currentGroup || this.currentMetric;
    }

    get scopeMode(): 'all' | 'selected' {
        return this.scopeOwner.displayScope?.mode === 'selected' ? 'selected' : 'all';
    }

    setScopeMode(mode: 'all' | 'selected') {
        const previous = this.scopeOwner.displayScope;
        this.scopeOwner.displayScope = {
            mode, profileIds: [...(previous?.profileIds || [])],
            profileNames: { ...(previous?.profileNames || {}) }, excludedProfileIds: [...(previous?.excludedProfileIds || [])]
        };
    }

    private get savedScopeProfiles(): ScopeChoice[] {
        const saved = this.config.store.profiles;
        if (!Array.isArray(saved)) return [];
        const groups = this.config.store.groups;
        const groupNames = new Map<string, string>((Array.isArray(groups) ? groups : [])
            .filter(group => group && typeof group.id === 'string' && typeof group.name === 'string')
            .map(group => [group.id, group.name]));
        const seen = new Set<string>();
        const profiles: ScopeChoice[] = saved.filter(profile => {
            if (!profile || typeof profile.id !== 'string' || !profile.id || seen.has(profile.id)) return false;
            seen.add(profile.id);
            return true;
        }).map(profile => ({
            id: profile.id, name: typeof profile.name === 'string' && profile.name ? profile.name : profile.id,
            type: typeof profile.type === 'string' ? profile.type : '',
            group: groupNames.get(profile.group) || (typeof profile.group === 'string' ? profile.group : '')
        }));
        for (const profile of profiles) {
            if (profiles.some(other => other.id !== profile.id && other.name === profile.name && other.group === profile.group)) {
                profile.disambiguator = profile.id.slice(-8);
            }
        }
        profiles.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        const panes = getLayoutPaneTargets(saved);
        return profiles.flatMap(profile => [profile, ...panes.filter(pane => pane.layoutId === profile.id).map(pane => ({
            ...pane, group: profile.group, storedName: layoutPaneTargetName(pane)
        }))]);
    }

    get scopeChoices(): ScopeChoice[] {
        const search = this.scopeSearch.trim().toLocaleLowerCase();
        const all = this.savedScopeProfiles;
        const matching = (profile: ScopeChoice) => `${profile.group} ${profile.name} ${profile.layoutName || ''}`.toLocaleLowerCase().includes(search);
        return all.filter(profile => {
            if (!search) return !profile.layoutId || !this.collapsedScopeLayouts.has(profile.layoutId);
            return matching(profile) || (profile.type === 'split-layout' && all.some(child => child.layoutId === profile.id && matching(child)));
        });
    }

    paneNumber(profile: ScopeChoice): string { return (profile.path || []).map(index => index + 1).join('.'); }
    toggleScopeLayout(id: string) { this.collapsedScopeLayouts.has(id) ? this.collapsedScopeLayouts.delete(id) : this.collapsedScopeLayouts.add(id); }

    get scopeSelectedProfiles(): Array<ScopeChoice & { missing: boolean }> {
        const scope = this.scopeOwner.displayScope;
        const saved = new Map(this.savedScopeProfiles.map(profile => [profile.id, profile]));
        return [...new Set(scope?.profileIds || [])].map(id => {
            const profile = saved.get(id);
            return profile ? { ...profile, name: profile.storedName || profile.name, missing: false } : {
                id, name: scope?.profileNames?.[id] || id, type: '', group: '', missing: true
            };
        });
    }

    get hasMissingScopeProfiles(): boolean { return this.scopeSelectedProfiles.some(profile => profile.missing); }
    trackScopeChoice(_: number, profile: ScopeChoice): string { return profile.id; }
    private scopeChoiceSelected(profile: ScopeChoice): boolean {
        const scope = this.scopeOwner.displayScope;
        if (scope?.excludedProfileIds?.includes(profile.id)) return false;
        const ids = scope?.profileIds || [];
        return ids.includes(profile.id) || Boolean(profile.layoutId && (ids.includes(profile.layoutId) ||
            (profile.connectionIds || [profile.profileId]).some(id => !!id && ids.includes(id) &&
                (this.config.store.profiles || []).some(saved => saved.id === id))));
    }

    isScopeSelected(id: string): boolean {
        const all = this.savedScopeProfiles;
        const profile = all.find(item => item.id === id);
        if (!profile) return false;
        const children = profile.type === 'split-layout' ? all.filter(item => item.layoutId === id) : [];
        return children.length ? children.every(child => this.scopeChoiceSelected(child)) : this.scopeChoiceSelected(profile);
    }

    isScopeIndeterminate(id: string): boolean {
        const children = this.savedScopeProfiles.filter(item => item.layoutId === id);
        return children.some(child => this.scopeChoiceSelected(child)) && !children.every(child => this.scopeChoiceSelected(child));
    }

    toggleScopeProfile(id: string, selected: boolean) {
        const scope = this.scopeOwner.displayScope;
        const ids = new Set(scope?.profileIds || []);
        const excluded = new Set(scope?.excludedProfileIds || []);
        const names = { ...(scope?.profileNames || {}) };
        const all = this.savedScopeProfiles;
        const profile = all.find(item => item.id === id);
        if (profile?.type === 'split-layout') {
            const children = all.filter(item => item.layoutId === id);
            if (selected) {
                ids.add(id);
                names[id] = profile.name;
                children.forEach(child => excluded.delete(child.id));
            } else {
                ids.delete(id);
                for (const child of children) {
                    ids.delete(child.id);
                    excluded.add(child.id);
                    names[child.id] = child.storedName || child.name;
                }
            }
        } else if (selected) {
            if (!profile) return;
            const connectionId = profile.profileId || profile.id;
            for (const target of all.filter(item => item.type !== 'split-layout' && (item.profileId || item.id) === connectionId)) {
                ids.add(target.id);
                excluded.delete(target.id);
                names[target.id] = target.storedName || target.name;
            }
        } else {
            // Legacy scopes may contain only the shared connection ID. Keep the
            // already checked layout occurrences when cancelling that one row.
            if (profile && !profile.layoutId) for (const pane of all.filter(item => item.layoutId &&
                (item.connectionIds || [item.profileId]).includes(id) && this.scopeChoiceSelected(item))) {
                ids.add(pane.id);
                names[pane.id] = pane.storedName || pane.name;
            }
            ids.delete(id);
            if (profile?.layoutId) {
                excluded.add(id);
                names[id] = profile.storedName || profile.name;
            } else {
                excluded.delete(id);
                delete names[id];
            }
        }
        for (const key of Object.keys(names)) if (!ids.has(key) && !excluded.has(key)) delete names[key];
        this.scopeOwner.displayScope = { mode: 'selected', profileIds: [...ids], excludedProfileIds: [...excluded], profileNames: names };
    }

    removeScopeProfile(id: string) { this.toggleScopeProfile(id, false); }

    private serializeScope(scope?: DisplayScope): DisplayScope | undefined {
        if (!scope) return undefined;
        const ids = [...new Set((scope.profileIds || []).filter(id => typeof id === 'string' && Boolean(id)))];
        const excludedProfileIds = [...new Set((scope.excludedProfileIds || []).filter(id => typeof id === 'string' && Boolean(id)))];
        const saved = new Map(this.savedScopeProfiles.map(profile => [profile.id, profile.storedName || profile.name]));
        const profileNames: Record<string, string> = {};
        for (const id of [...ids, ...excludedProfileIds]) profileNames[id] = saved.get(id) || scope.profileNames?.[id] || id;
        return { mode: scope.mode === 'selected' ? 'selected' : 'all', profileIds: ids, excludedProfileIds, profileNames };
    }

    @HostListener('document:click')
    onDocumentClick() {
        if (this.iconPickerOpen) {
            this.iconPickerOpen = false;
        }
    }

    toggleIconPicker(event: Event) {
        event.stopPropagation();
        this.iconPickerOpen = !this.iconPickerOpen;
    }

    get iconCategories(): string[] {
        return [...new Set(this.iconPresets.map(preset => preset.category || 'Other'))];
    }

    get filteredIconPresets(): IconPresetChoice[] {
        const terms = this.iconSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        return this.iconPresets.filter(preset => {
            const category = preset.category || 'Other';
            if (this.iconCategory !== 'all' && category !== this.iconCategory) return false;
            const keywords = Array.isArray(preset.keywords) ? preset.keywords.join(' ') : preset.keywords || '';
            const searchable = `${preset.name} ${preset.label} ${category} ${keywords}`.toLocaleLowerCase();
            return terms.every(term => searchable.includes(term));
        });
    }

    trackIconPreset(_: number, preset: IconPresetChoice): string { return preset.name; }

    selectPresetIcon(name: string) {
        this.currentMetric.icon = name;
        this.iconPickerOpen = false;
    }

    getIconClass(icon?: string): string {
        return formatFontAwesomeIcon(icon);
    }

    getSvgPath(icon?: string): string | null {
        return getSvgPresetPath(icon);
    }

    isUrl(icon?: string): boolean {
        return isUrlOrDataUri(icon);
    }
    iconMask(icon: string): string { return `url(${JSON.stringify(icon)})`; }

    isFa(icon?: string): boolean {
        return isFaIcon(icon);
    }

    getSafeIconUrl(icon?: string): SafeUrl | string {
        if (!icon) return '';
        if (icon.startsWith('data:image/')) {
            return this.sanitizer.bypassSecurityTrustUrl(icon);
        }
        return icon;
    }

    clearIcon() {
        this.currentMetric.icon = '';
        this.iconPickerOpen = false;
    }

    onSvgFileSelected(event: any) {
        const file = event.target?.files?.[0];
        if (!file) return;
        const targetMetric = this.currentMetric;
        const reader = new FileReader();
        reader.onload = (e: any) => {
            const result = e.target?.result as string;
            if (result) {
                targetMetric.icon = result;
                this.iconPickerOpen = false;
            }
        };
        reader.readAsDataURL(file);
        event.target.value = '';
    }

    get defaultInterval(): number {
        return this.config?.store?.plugin?.serverStats?.defaultInterval || 10;
    }

    set defaultInterval(val: number) {
        if (!this.config?.store?.plugin?.serverStats) return;
        const num = Number(val);
        this.config.store.plugin.serverStats.defaultInterval = isNaN(num) || num < 1 ? 10 : num;
    }

    get debugLogging(): boolean {
        return Boolean(this.config?.store?.plugin?.serverStats?.debugLogging);
    }

    set debugLogging(val: boolean) {
        if (!this.config?.store) {
            return;
        }
        if (!this.config.store.plugin) {
            this.config.store.plugin = {};
        }
        if (!this.config.store.plugin.serverStats) {
            this.config.store.plugin.serverStats = {};
        }
        this.config.store.plugin.serverStats.debugLogging = Boolean(val);
    }

    get showDefaultIcons(): boolean {
        return this.config?.store?.plugin?.serverStats?.showDefaultIcons !== false;
    }

    set showDefaultIcons(val: boolean) {
        if (!this.config?.store) {
            return;
        }
        if (!this.config.store.plugin) {
            this.config.store.plugin = {};
        }
        if (!this.config.store.plugin.serverStats) {
            this.config.store.plugin.serverStats = {};
        }
        this.config.store.plugin.serverStats.showDefaultIcons = Boolean(val);
    }

    addColorRule() {
        if (!this.currentMetric.colorRules) {
            this.currentMetric.colorRules = [];
        }
        this.currentMetric.colorRules.push({
            operator: '==',
            value: '',
            color: METRIC_COLORS.red
        });
    }

    removeColorRule(index: number) {
        if (this.currentMetric.colorRules) {
            this.currentMetric.colorRules.splice(index, 1);
        }
    }

    get customMetrics(): CustomMetric[] {
        return this.config.store.plugin.serverStats.customMetrics || [];
    }

    get metricGroups(): CustomMetricGroup[] {
        return this.config.store.plugin.serverStats.metricGroups || [];
    }

    get metricEditorTitle(): string {
        if (this.editingBuiltinKey && !this.currentGroup) return 'Edit Built-in Metric';
        if (this.currentGroup) return this.editingChildIndex < 0 ? 'Main Metric' : 'Child Metric';
        return this.editingIndex < 0 ? 'Add New Metric' : 'Edit Metric';
    }

    private uiText(key: string): string {
        const configured = this.config.store.language;
        const locale = String(configured && configured !== 'auto' ? configured : typeof navigator !== 'undefined' ? navigator.language : 'en');
        return TRANSLATIONS[locale]?.[key] || TRANSLATIONS[locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en']?.[key] || key;
    }

    tutorialOpening = false;
    tutorialError = '';

    async openTutorial() {
        if (this.tutorialOpening) return;
        this.tutorialOpening = true;
        this.tutorialError = '';
        const configured = this.config.store.language;
        const locale = String(configured && configured !== 'auto' ? configured : typeof navigator !== 'undefined' ? navigator.language : 'en');
        try {
            await openTutorialPdf(locale);
        } catch (error) {
            this.tutorialError = this.uiText(error?.code === 'missing'
                ? 'The tutorial PDF is missing. Reinstall the plugin and try again.'
                : 'Could not open the tutorial PDF. Check your default PDF reader and try again.');
        } finally {
            this.tutorialOpening = false;
        }
    }

    private copyLabel(label: string, existing: string[]): string {
        const base = `${label || this.uiText('Unnamed Metric')} (${this.uiText('Copy')})`;
        let candidate = base;
        let number = 2;
        while (existing.includes(candidate)) candidate = `${base} ${number++}`;
        return candidate;
    }

    private independentCopy<T extends { id: string }>(item: T, prefix: string): T {
        const copy = JSON.parse(JSON.stringify(item));
        copy.id = this.newId(prefix);
        // A deliberate copy is editable independently of the source preset.
        delete copy.presetOrigin;
        delete copy.presetMetadata;
        return copy;
    }

    copyGroup(index: number) {
        const original = this.metricGroups[index];
        if (!original) return;
        const copy = this.independentCopy(original, 'group');
        copy.label = this.copyLabel(original.label, this.metricGroups.map(group => group.label));
        copy.main = this.independentCopy(original.main, 'metric');
        copy.children = original.children.map(child => this.independentCopy(child, 'metric'));
        const groups = [...this.metricGroups];
        groups.splice(index + 1, 0, copy);
        this.config.store.plugin.serverStats.metricGroups = groups;
        this.save();
        this.editGroup(index + 1);
    }

    copyChild(index: number) {
        const original = this.currentGroup?.children[index];
        if (!original) return;
        const copy = this.independentCopy(original, 'metric');
        copy.label = this.copyLabel(original.label, [this.currentGroup.main, ...this.currentGroup.children].map(metric => metric.label));
        this.currentGroup.children.splice(index + 1, 0, copy);
        this.selectGroupMetric(index + 1);
    }

    groupModeLabel(mode: string): string {
        return mode === 'carousel' ? 'Carousel' : mode === 'static' ? 'Static' : 'Overview';
    }

    groupModeHelp(mode: string): string {
        if (mode === 'carousel') return 'Rotate child metrics. Hover pauses rotation; click to expand all members with details.';
        if (mode === 'static') return 'Show all members. Click expands one horizontal member or the whole vertical group; click again or move away to close.';
        return 'Show the main metric. Click to expand all members with details; click again or move away to close.';
    }

    private newId(prefix: string): string {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    }

    private draftMetric(metric?: Partial<CustomMetric>): CustomMetric {
        return {
            ...this.defaultMetric,
            id: this.newId('metric'),
            label: '', command: '', type: 'text',
            ...JSON.parse(JSON.stringify(metric || {})),
            // Existing missing modes used exit-code semantics before output became the new-item default.
            checkMode: metric ? (metric.checkMode || 'exitCode') : 'output',
            checkExpected: metric ? String(metric.checkExpected ?? '0') : '',
            enabled: metric?.enabled !== false,
            visibleWhenUnavailable: metric?.visibleWhenUnavailable !== false,
            showWhenUnavailable: metric?.visibleWhenUnavailable !== false && metric?.showWhenUnavailable !== false,
            colorRules: JSON.parse(JSON.stringify(metric?.colorRules || []))
        } as CustomMetric;
    }

    newSingle() {
        this.cancelEdit();
        this.newSingleOpen = true;
    }

    newGroup() {
        this.cancelEdit();
        this.currentGroup = {
            id: this.newId('group'), label: '', mode: 'overview', layout: 'vertical', enabled: true,
            interval: 3, emptyText: '', main: this.draftMetric(), children: []
        };
        this.selectGroupMetric(-1);
    }

    editGroup(index: number) {
        const group = this.metricGroups[index];
        if (!group) return;
        if (this.editingGroupId === group.id && this.currentGroup) {
            this.iconPickerOpen = false;
            return;
        }
        this.cancelEdit();
        this.editingGroupId = group.id;
        this.currentGroup = {
            ...JSON.parse(JSON.stringify(group)),
            main: this.draftMetric(group.main),
            children: (group.children || []).map(m => this.draftMetric(m))
        };
        this.selectGroupMetric(-1);
        this.expandedMemberId = null;
    }

    editGroupMember(groupIndex: number, memberIndex = -1) {
        const group = this.metricGroups[groupIndex];
        if (!group || memberIndex < -1 || memberIndex >= group.children.length) return;
        this.editGroup(groupIndex);
        this.navigateMember(memberIndex);
    }

    toggleGroupMetric(index: number) {
        if (!this.currentGroup) return;
        const metric = index < 0 ? this.currentGroup.main : this.currentGroup.children[index];
        if (!metric) return;
        this.activateMetric(metric);
        if (this.expandedMembers.has(metric.id)) {
            this.expandedMembers.delete(metric.id);
            this.iconPickerOpen = false;
        } else this.selectGroupMetric(index);
    }

    toggleMetricEnabled(index: number) {
        const metric = this.customMetrics[index];
        if (!metric) return;
        metric.enabled = metric.enabled === false;
        if (!this.currentGroup && this.currentMetric.id === metric.id) this.currentMetric.enabled = metric.enabled;
        this.save();
    }

    toggleGroupEnabled(index: number) {
        const group = this.metricGroups[index];
        if (!group) return;
        group.enabled = group.enabled === false;
        if (this.currentGroup?.id === group.id) this.currentGroup.enabled = group.enabled;
        this.save();
    }

    toggleMemberEnabled(metric: CustomMetric) { this.activateMetric(metric); metric.enabled = metric.enabled === false; }

    setUnavailableVisibility(visible: boolean) {
        this.currentMetric.visibleWhenUnavailable = visible;
        if (!visible) this.currentMetric.showWhenUnavailable = false;
    }

    selectGroupMetric(index: number) {
        if (!this.currentGroup) return;
        const metric = index < 0 ? this.currentGroup.main : this.currentGroup.children[index];
        if (!metric) return;
        this.activateMetric(metric);
        this.expandedMemberId = metric.id;
        this.iconPickerOpen = false;
    }

    addChild() {
        if (!this.currentGroup) return;
        this.currentGroup.children.push(this.draftMetric());
        this.navigateMember(this.currentGroup.children.length - 1);
    }

    removeChild(index: number) {
        const child = this.currentGroup?.children[index];
        if (!child || !confirm(this.uiText('Delete this child metric?') + '\n\n' + (this.currentGroup.label || this.uiText('Metric Group')) + ' / ' + (child.label || child.icon || this.uiText('Unnamed Metric')))) return;
        const selectedId = this.currentMetric.id;
        this.expandedMembers.delete(child.id);
        this.currentGroup.children.splice(index, 1);
        this.activateMetric(this.currentGroup.children.find(m => m.id === selectedId) || this.currentGroup.main);
    }

    moveChild(index: number, direction: number) {
        if (!this.currentGroup) return;
        const children = this.currentGroup.children;
        const target = index + direction;
        if (target < 0 || target >= children.length) return;
        const selectedId = this.currentMetric.id;
        const item = children.splice(index, 1)[0];
        children.splice(target, 0, item);
        this.activateMetric(children.find(m => m.id === selectedId) || this.currentGroup.main);
    }

    moveGroup(index: number, direction: number) {
        const groups = [...this.metricGroups];
        const target = index + direction;
        if (target < 0 || target >= groups.length) return;
        const item = groups.splice(index, 1)[0];
        groups.splice(target, 0, item);
        this.config.store.plugin.serverStats.metricGroups = groups;
        this.save();
    }

    removeGroup(index: number) {
        const group = this.metricGroups[index];
        if (!group || !confirm(this.uiText('Delete this group and all of its metrics?') + '\n\n' + (group.label || group.main.label || this.uiText('Metric Group')))) return;
        this.config.store.plugin.serverStats.metricGroups = this.metricGroups.filter(g => g.id !== group.id);
        if (this.editingGroupId === group.id) this.cancelEdit();
        this.save();
    }

    private positiveOrAbsent(value: any): boolean {
        return value === undefined || value === null || value === '' || (Number.isFinite(Number(value)) && Number(value) >= 1);
    }

    isMetricValid(metric: Partial<CustomMetric>): boolean {
        if (!(metric.label?.trim() || metric.icon?.trim()) || !metric.command?.trim()) return false;
        if (!this.positiveOrAbsent(metric.interval) || !this.positiveOrAbsent(metric.timeout)) return false;
        if (metric.type === 'progress' && !this.positiveOrAbsent(metric.maxValue)) return false;
        if (metric.checkCommand?.trim() && metric.checkMode !== 'output') {
            const expected = String(metric.checkExpected ?? '0').trim();
            if (!/^\d+$/.test(expected) || Number(expected) > 255) return false;
        }
        return true;
    }

    isGroupValid(): boolean {
        return Boolean(this.currentGroup && this.positiveOrAbsent(this.currentGroup.interval) &&
            [this.currentGroup.main, ...this.currentGroup.children].every(m => this.isMetricValid(m)));
    }

    private serializeMetric(metric: Partial<CustomMetric>, grouped = false): CustomMetric {
        const optionalNumber = (value: any) => value === undefined || value === null || value === '' ? undefined : Number(value);
        return {
            ...JSON.parse(JSON.stringify(metric)),
            id: metric.id || this.newId('metric'),
            label: metric.label?.trim() || '', command: metric.command!, type: metric.type || 'text',
            icon: metric.icon?.trim() || undefined, color: metric.color || '#00ff00',
            maxValue: optionalNumber(metric.maxValue),
            interval: optionalNumber(metric.interval), timeout: optionalNumber(metric.timeout),
            checkCommand: metric.checkCommand || '', checkMode: metric.checkMode || 'exitCode',
            checkExpected: String(metric.checkExpected ?? '0'),
            unavailableText: metric.unavailableText?.trim() || 'Unavailable',
            detailCommand: metric.detailCommand || '',
            enabled: metric.enabled !== false,
            visibleWhenUnavailable: metric.visibleWhenUnavailable !== false,
            showWhenUnavailable: metric.visibleWhenUnavailable !== false && metric.showWhenUnavailable !== false,
            displayScope: grouped ? undefined : this.serializeScope(metric.displayScope),
            colorRules: JSON.parse(JSON.stringify(metric.colorRules || []))
        };
    }

    saveGroup(close = false) {
        if (this.editingBuiltinKey) { this.saveBuiltin(close); return; }
        if (!this.currentGroup || !this.isGroupValid()) return;
        const group: CustomMetricGroup = {
            ...this.currentGroup,
            label: this.currentGroup.label?.trim() || '',
            interval: Number(this.currentGroup.interval) || 3,
            displayScope: this.serializeScope(this.currentGroup.displayScope),
            main: this.serializeMetric(this.currentGroup.main, true),
            children: this.currentGroup.children.map(m => this.serializeMetric(m, true))
        };
        const groups = [...this.metricGroups];
        const index = this.editingGroupId ? groups.findIndex(g => g.id === this.editingGroupId) : -1;
        if (index < 0) groups.push(group);
        else groups[index] = group;
        this.config.store.plugin.serverStats.metricGroups = groups;
        this.editingGroupId = group.id;
        this.save();
        this.afterSave(close);
    }

    get defaultMetricsConfig() {
        if (!this.config.store.plugin.serverStats.defaultMetrics) {
            this.config.store.plugin.serverStats.defaultMetrics = { ram: true, net: true, load: true };
        }
        return this.config.store.plugin.serverStats.defaultMetrics;
    }

    builtinMain(key: BuiltinMetricKey): CustomMetric {
        const definition = getBuiltinDefinition(key, this.config.store.plugin.serverStats);
        return key === 'net' || key === 'load' ? (definition as CustomMetricGroup).main : definition as CustomMetric;
    }

    builtinTitle(key: BuiltinMetricKey): string {
        return getBuiltinDefinition(key, this.config.store.plugin.serverStats).label || key;
    }

    hasBuiltinOverride(key: BuiltinMetricKey): boolean {
        return Boolean(this.config.store.plugin.serverStats.defaultMetricOverrides?.[key]);
    }

    toggleBuiltinEnabled(key: BuiltinMetricKey) {
        this.defaultMetricsConfig[key] = this.defaultMetricsConfig[key] === false;
        this.save();
    }

    editBuiltin(key: BuiltinMetricKey) {
        if (this.editingBuiltinKey === key) {
            if (this.currentGroup) {
                this.expandedMemberId = null;
                this.iconPickerOpen = false;
            }
            return;
        }
        this.cancelEdit();
        this.editingBuiltinKey = key;
        const definition = getBuiltinDefinition(key, this.config.store.plugin.serverStats);
        if (key === 'net' || key === 'load') {
            const group = JSON.parse(JSON.stringify(definition)) as CustomMetricGroup;
            this.currentGroup = { ...group, main: this.draftMetric(group.main), children: group.children.map(child => this.draftMetric(child)) };
            this.selectGroupMetric(-1);
            this.expandedMemberId = null;
        } else this.currentMetric = this.draftMetric(definition as CustomMetric);
    }

    restoreBuiltin(key: BuiltinMetricKey) {
        const overrides = this.config.store.plugin.serverStats.defaultMetricOverrides;
        if (overrides) delete overrides[key];
        if (this.editingBuiltinKey === key) this.cancelEdit();
        this.save();
    }

    private saveBuiltin(close = false) {
        const key = this.editingBuiltinKey;
        if (!key || ((key === 'net' || key === 'load') ? !this.isGroupValid() : !this.isMetricValid(this.currentMetric))) return;
        const conf = this.config.store.plugin.serverStats;
        conf.defaultMetricOverrides = conf.defaultMetricOverrides || {};
        conf.defaultMetricOverrides[key] = key === 'net' || key === 'load' ? {
            ...this.currentGroup,
            label: this.currentGroup.label?.trim() || '',
            interval: Number(this.currentGroup.interval) || 3,
            displayScope: this.serializeScope(this.currentGroup.displayScope),
            main: this.serializeMetric(this.currentGroup.main, true),
            children: this.currentGroup.children.map(child => this.serializeMetric(child, true))
        } : this.serializeMetric(this.currentMetric);
        this.save();
        this.afterSave(close);
    }

    presetText(preset: MetricPreset, field: 'label' | 'description'): string {
        const configured = this.config.store.language;
        const locale = configured && configured !== 'auto' ? configured : typeof navigator !== 'undefined' ? navigator.language : 'en';
        const language = String(locale).toLowerCase().startsWith('zh') ? 'zh' : 'en';
        const choices = field === 'label' ? preset.labels : preset.descriptions;
        return choices?.[language] || preset[field] || '';
    }

    presetMain(preset: MetricPreset): CustomMetric { return preset.kind === 'group' ? preset.group.main : preset.metric; }
    trackPreset(_: number, preset: MetricPreset): string { return preset.id; }
    get filteredPresets(): MetricPreset[] {
        const terms = this.presetSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        return this.presets.filter(preset => {
            const text = [preset.label, preset.description, ...Object.values(preset.labels || {}), ...Object.values(preset.descriptions || {}), ...(preset.profileNames || [])].join(' ').toLocaleLowerCase();
            return terms.every(term => text.includes(term));
        });
    }

    loadPresetLibrary(input: unknown) {
        const incoming = normalizePresetLibrary(input);
        const ids = new Set(incoming.map(preset => preset.id));
        this.presets = [...incoming, ...this.presets.filter(preset => !ids.has(preset.id))];
        this.presetSearch = '';
        this.presetMissingNames = [];
        this.fetchError = false;
        this.presetMessage = 'Library loaded. Review an item and click Add to enable it.';
    }

    openPresetSource() { this.platform.openExternal(DEFAULT_GITHUB_PRESETS_URL); }

    async fetchPresets() {
        if (this.loadingPresets) return;
        this.loadingPresets = true;
        this.fetchError = false;
        this.presetMessage = '';
        this.presetMissingNames = [];
        try {
            const incoming = await fetchGitHubPresets();
            this.loadPresetLibrary(incoming);
        } catch (error) {
            this.fetchError = true;
            this.presetMessage = error instanceof PresetGitHubError ? error.message : 'Unable to download presets from GitHub.';
        } finally {
            this.loadingPresets = false;
        }
    }

    importPresetFile(event: any) {
        const file = event.target?.files?.[0];
        if (!file) return;
        this.fetchError = false;
        const targetMetric = this.currentMetric;
        const reader = new FileReader();
        reader.onload = () => {
            try { this.loadPresetLibrary(JSON.parse(String(reader.result || ''))); }
            catch { this.presetMessage = 'Unable to read this preset library. Choose a valid JSON library.'; this.presetMissingNames = []; }
        };
        reader.onerror = () => { this.presetMessage = 'Unable to read this preset library. Choose a valid JSON library.'; };
        reader.readAsText(file);
        event.target.value = '';
    }

    currentPresetLibrary(): string {
        const profiles = new Map(this.savedScopeProfiles.map(profile => [profile.id, profile.storedName || profile.name]));
        const targets = (item: { displayScope?: DisplayScope }) => (item.displayScope?.profileIds || []).map(id => {
            const name = profiles.get(id) || item.displayScope?.profileNames?.[id];
            return typeof name === 'string' ? name.trim() : '';
        }).filter(Boolean);
        const portable = (item: PresetItem, kind: 'metric' | 'group'): MetricPreset => {
            const copy = JSON.parse(JSON.stringify(item));
            const metadata = copy.presetMetadata as ImportedPresetMetadata | undefined;
            delete copy.presetMetadata;
            return {
                id: item.id, kind, label: item.label || (kind === 'metric' ? (item as CustomMetric).icon || 'Metric' : (item as CustomMetricGroup).main.label || 'Group'),
                // A user rename is authoritative; only unchanged preset titles remain bilingual.
                labels: metadata?.importedLabel === item.label ? metadata.labels : undefined,
                description: metadata?.description, descriptions: metadata?.descriptions, source: metadata?.source, audience: metadata?.audience,
                ...(kind === 'metric' ? { metric: copy } : { group: copy }),
                profileNames: item.displayScope?.mode === 'selected' ? targets(item) : undefined
            };
        };
        const presets: MetricPreset[] = [
            ...this.customMetrics.map(metric => portable(metric, 'metric')),
            ...this.metricGroups.map(group => portable(group, 'group'))
        ];
        return exportPresetLibrary(presets);
    }

    exportCurrentPresets() {
        const url = URL.createObjectURL(new Blob([this.currentPresetLibrary()], { type: 'application/json;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'tabby-metric-presets.json';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.presetMessage = 'Label library exported.';
        this.presetMissingNames = [];
    }

    isPresetAdded(preset: MetricPreset): boolean {
        return !!findInstalledPreset(preset, this.config.store.plugin.serverStats, this.config.store.profiles || []);
    }

    addPreset(preset: MetricPreset | Partial<CustomMetric>) {
        const normalized = 'kind' in preset ? preset as MetricPreset : normalizePresetLibrary([preset])[0];
        if (!normalized) return;
        if (this.isPresetAdded(normalized)) {
            this.presetMessage = 'This preset is already added. Edit or enable the existing item.';
            return;
        }
        const imported = instantiatePreset(normalized, this.config.store.profiles || [], () => this.newId('metric'));
        // Only an explicitly bilingual preset title is localized on addition.
        // User-supplied names and mount paths are otherwise kept exactly as entered.
        if (normalized.labels) {
            imported.customMetrics.forEach(metric => { metric.label = this.presetText(normalized, 'label'); });
            imported.metricGroups.forEach(group => { group.label = this.presetText(normalized, 'label'); });
        }
        for (const item of [...imported.customMetrics, ...imported.metricGroups] as PresetItem[]) {
            item.presetMetadata = {
                importedLabel: item.label || '', labels: normalized.labels,
                description: normalized.description, descriptions: normalized.descriptions, source: normalized.source, audience: normalized.audience
            };
        }
        const conf = this.config.store.plugin.serverStats;
        conf.customMetrics = [...(conf.customMetrics || []), ...imported.customMetrics];
        conf.metricGroups = [...(conf.metricGroups || []), ...imported.metricGroups];
        this.presetMissingNames = imported.missingProfileNames;
        this.presetMessage = imported.missingProfileNames.length ? 'Added with a restricted scope. Choose the missing connections before use.' : 'Preset added.';
        this.save();
    }

    editMetric(index: number) {
        this.cancelEdit();
        this.editingIndex = index;
        this.iconPickerOpen = false;
        this.currentMetric = this.draftMetric(this.customMetrics[index]);
    }

    cancelEdit() {
        this.closePrompt = false; this.saveNotice = ''; this.singleExpanded = true;
        this.editingBuiltinKey = null;
        this.scopeSearch = '';
        this.iconSearch = '';
        this.iconCategory = 'all';
        this.currentGroup = null;
        this.editingGroupId = null;
        this.newSingleOpen = false;
        this.editingChildIndex = -1;
        this.expandedMemberId = null;
        this.editingIndex = -1;
        this.iconPickerOpen = false;
        this.currentMetric = { ...this.defaultMetric, colorRules: [] };
    }

    saveMetric(close = false) {
        if (this.editingBuiltinKey) { this.saveBuiltin(close); return; }
        if (this.currentGroup) { this.saveGroup(close); return; }
        if (!this.isMetricValid(this.currentMetric)) return;

        if (!this.config.store.plugin.serverStats.customMetrics) {
            this.config.store.plugin.serverStats.customMetrics = [];
        }

        const metricToSave = this.serializeMetric(this.currentMetric);

        if (this.editingIndex === -1) {
            this.config.store.plugin.serverStats.customMetrics.push(metricToSave);
        } else {
            const index = this.customMetrics.findIndex(m => m.id === metricToSave.id);
            if (index < 0) return;
            this.config.store.plugin.serverStats.customMetrics[index] = metricToSave;
        }
        this.editingIndex = this.customMetrics.findIndex(metric => metric.id === metricToSave.id);
        this.currentMetric = this.draftMetric(metricToSave);
        this.newSingleOpen = false;
        this.save();
        this.afterSave(close);
    }

    removeMetric(index: number) {
        const metric = this.customMetrics[index];
        if (!metric) return;
        if (confirm(this.uiText('Are you sure you want to delete this metric?') + '\n\n' + (metric.label || metric.icon || this.uiText('Unnamed Metric')))) {
            const removedId = metric.id;
            this.config.store.plugin.serverStats.customMetrics.splice(index, 1);
            this.save();
            if (!this.currentGroup && this.currentMetric.id === removedId) {
                this.cancelEdit();
            }
        }
    }

    onDragStart(index: number) { this.draggedIndex = index; }
    onDragOver(event: DragEvent, index: number) { event.preventDefault(); }
    onDrop(targetIndex: number) {
        this.isDragging = false;
        if (this.draggedIndex === null || this.draggedIndex === targetIndex) return;
        const metrics = this.customMetrics;
        const item = metrics[this.draggedIndex];
        metrics.splice(this.draggedIndex, 1);
        metrics.splice(targetIndex, 0, item);
        this.config.store.plugin.serverStats.customMetrics = [...metrics];
        this.save();
        this.draggedIndex = null;
    }

    get hexColor(): string {
        const bg = this.config.store.plugin.serverStats.style.background;
        if (!bg) return '#141414';
        if (bg.startsWith('rgba')) {
            const parts = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (parts) {
                const r = parseInt(parts[1]).toString(16).padStart(2, '0');
                const g = parseInt(parts[2]).toString(16).padStart(2, '0');
                const b = parseInt(parts[3]).toString(16).padStart(2, '0');
                return `#${r}${g}${b}`;
            }
        }
        if (bg.startsWith('#')) return bg.substring(0, 7);
        return '#141414';
    }

    get opacity(): number {
        const bg = this.config.store.plugin.serverStats.style.background;
        if (!bg) return 0.9;
        if (bg.startsWith('rgba')) {
            const parts = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (parts && parts[4]) {
                return parseFloat(parts[4]);
            }
        }
        return 1.0;
    }

    setHexColor(hex: string) {
        const currentOpacity = this.opacity;
        this.updateColor(hex, currentOpacity);
    }

    setOpacity(val: number) {
        const currentHex = this.hexColor;
        this.updateColor(currentHex, val);
    }

    openGitHubLink() {
        this.platform.openExternal('https://github.com/lishuainan0209/tabby-group-server-stats');
    }

    private updateColor(hex: string, opacity: number) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        this.config.store.plugin.serverStats.style.background = `rgba(${r}, ${g}, ${b}, ${opacity})`;
        this.save();
    }

    save() { this.config.save(); }
}

@Injectable()
export class ServerStatsSettingsTabProvider extends SettingsTabProvider {
    constructor(private translate: TranslateService) {
        super();
        setTimeout(() => this.setTitle(this.translate.instant('Bottom Status Bar')), 10);
    }

    id = 'server-stats';
    icon = 'fas fa-server';
    title = this.translate.instant('Bottom Status Bar');

    setTitle(title: string) {
        this.title = title;
    }

    getComponentType(): any { return ServerStatsSettingsComponent; }
}
