import { Injectable } from '@angular/core'
import { ToolbarButtonProvider, ToolbarButton } from 'tabby-core'

@Injectable()
export class StatsToolbarButtonProvider extends ToolbarButtonProvider {
    // Retained as an import-compatible legacy class; the plugin no longer
    // registers a toolbar control or exposes a separate floating view.
    provide(): ToolbarButton[] {
        return []
    }
}
