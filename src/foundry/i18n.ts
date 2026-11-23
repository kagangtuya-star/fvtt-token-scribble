const PREFIX = "TOKEN_SCRIBBLE";

/** Localise `TOKEN_SCRIBBLE.<key>`, formatting `{placeholders}` when data is given. */
export function t(key: string, data?: Record<string, string | number>): string {
  const full = `${PREFIX}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

/** Escape text for insertion into HTML (dialog content, tooltips). */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
