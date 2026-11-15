import type { Theme } from '../persistence/prefs';

/**
 * Switches the colours of the application. Every colour of its chrome comes
 * from CSS variables, and each theme is a set of values for them, chosen by
 * this attribute on the document's root element.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
