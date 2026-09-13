export const INPUT_MODES = ['normal', 'vim', 'dictation'] as const
export type InputMode = typeof INPUT_MODES[number]
export const inputModeLabel = (mode: InputMode) => mode === 'vim' ? 'Vim' : mode === 'dictation' ? 'Dictation' : 'Normal'
