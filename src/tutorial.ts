export type TutorialOpenErrorCode = 'missing' | 'openFailed'

export class TutorialOpenError extends Error {
    constructor(public readonly code: TutorialOpenErrorCode, public readonly cause?: unknown) {
        super(code === 'missing' ? 'The tutorial PDF is missing.' : 'The tutorial PDF could not be opened.')
        this.name = 'TutorialOpenError'
    }
}

/** Open the bundled tutorial with the system's PDF application. */
export async function openTutorialPdf(locale: string): Promise<void> {
    try {
        // Keep native modules lazy so loading the settings page needs no Electron
        // shell. Webpack preserves __dirname as the installed bundle's directory.
        const path = require('path') as typeof import('path')
        const fs = require('fs') as typeof import('fs')
        const language = String(locale || 'en').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
        // Windows' native shell needs a normalized path, not mixed separators
        // and a literal "dist/../docs" suffix that Node's fs happens to accept.
        const filename = path.resolve(__dirname, '..', 'docs', `tutorial.${language}.pdf`)
        if (!fs.existsSync(filename)) throw new TutorialOpenError('missing')
        const electron = require('electron') as { shell: { openPath(path: string): Promise<string> } }
        // Tabby's PlatformService.openPath discards this promise and error text.
        // Electron resolves with a nonempty string on many native-open failures.
        const message = await electron.shell.openPath(filename)
        if (message) throw new TutorialOpenError('openFailed', message)
    } catch (error) {
        if (error instanceof TutorialOpenError) throw error
        throw new TutorialOpenError('openFailed', error)
    }
}
