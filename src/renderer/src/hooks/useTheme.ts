import { useEffect } from 'react'
import type { ThemePreference } from '@shared/types'

/**
 * Applies the saved appearance to the document.
 *
 * styles.css already defines the palette for three states — a bare `:root` for
 * light, a `prefers-color-scheme` block guarded against an explicit light
 * choice, and a `[data-theme='dark']` block — so all this has to do is set or
 * clear the attribute. "system" REMOVES it rather than writing
 * `data-theme="system"`: the media query is what should win then, and an
 * attribute matching neither selector would leave the page on the light palette
 * regardless of the OS.
 *
 * Applied to `documentElement` and not to a React-rendered wrapper so the
 * background is right before the first paint of any component, and so a portal
 * or a dialog rendered outside the tree still inherits it.
 */
export function useTheme(theme: ThemePreference | undefined): void {
  useEffect(() => {
    if (theme === undefined) return

    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)

    /**
     * Tell the engine which palettes exist, so form controls, scrollbars and
     * the text caret follow too. Without it those are drawn light on a dark
     * ground — the classic half-themed window — because they are painted by the
     * platform rather than by our CSS.
     */
    root.style.colorScheme = theme === 'system' ? 'light dark' : theme
  }, [theme])
}
