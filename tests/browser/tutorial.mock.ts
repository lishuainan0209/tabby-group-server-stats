// OS integration is checked by tutorial.test.cjs; the browser exercises feedback.
export async function openTutorialPdf(locale: string): Promise<void> {
    const state = window as any;
    if (state.tutorialOpenFailure) throw { code: state.tutorialOpenFailure };
    state.openedTutorial = `/plugin/docs/tutorial.${locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'}.pdf`;
}
