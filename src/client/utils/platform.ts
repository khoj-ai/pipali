export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';
export const ALT_KEY = IS_MAC ? '⌥' : 'Alt+';
/** Enter writes a newline here; sending and saving are done with the on-screen buttons. */
export const IS_TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
