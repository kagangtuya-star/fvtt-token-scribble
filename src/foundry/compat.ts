/**
 * Version adapter. Every Foundry API whose shape differs between generations,
 * or that is easy to misuse, is reached through here so the rest of the code
 * never branches on version numbers.
 *
 * Checked against the v13 client source and the v14 type definitions (see docs/COMPATIBILITY.md).
 */

export const SUPPORTED_GENERATIONS = [13, 14] as const;

export function generation(): number {
  return game.release?.generation ?? Number.parseInt(game.version, 10);
}

export function isSupported(): boolean {
  return generation() >= SUPPORTED_GENERATIONS[0];
}

/** Render hooks pass an HTMLElement in AppV2 (v13+); tolerate a jQuery wrapper from AppV1 subclasses. */
export function rootElement(html: unknown): HTMLElement | null {
  if (html instanceof HTMLElement) return html;
  const maybeJq = html as { 0?: unknown } | null;
  return maybeJq && maybeJq[0] instanceof HTMLElement ? maybeJq[0] : null;
}

/** `getSceneControlButtons` receives a record keyed by control name since v13. */
export interface SceneControlTool {
  name: string;
  title: string;
  icon: string;
  order?: number;
  button?: boolean;
  visible?: boolean;
  onChange?: (event: Event, active: boolean) => void;
}

export function tokenToolRecord(controls: unknown): Record<string, SceneControlTool> | null {
  const rec = controls as Record<string, { tools?: Record<string, SceneControlTool> } | undefined> | null;
  const tokens = rec?.tokens ?? rec?.token;
  return tokens?.tools ?? null;
}

export async function confirm(title: string, contentHtml: string, yesLabel?: string): Promise<boolean> {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) return window.confirm(`${title}\n\n${contentHtml.replace(/<[^>]+>/g, "")}`);
  const result = await DialogV2.confirm({
    window: { title },
    content: contentHtml,
    rejectClose: false,
    modal: true,
    ...(yesLabel ? { yes: { label: yesLabel, default: true } } : {}),
  });
  return result === true;
}

export function notify(level: "info" | "warn" | "error", message: string): void {
  ui.notifications?.[level](message);
}

/** The board element whose pointer events Foundry's canvas consumes. */
export function boardElement(): HTMLCanvasElement | null {
  return canvas?.app?.view ?? null;
}

export function documentSize(doc: FoundryTokenDocument): { width: number; height: number } {
  if (typeof doc.getSize === "function") return doc.getSize();
  const grid = canvas.grid?.size ?? 100;
  return { width: doc.width * grid, height: doc.height * grid };
}

/** Is `texture` a video (needs per-frame recomposition)? */
export function isVideoTexture(texture: PIXI.Texture | undefined): boolean {
  const resource = texture?.baseTexture?.resource;
  return !!resource && typeof PIXI.VideoResource === "function" && resource instanceof PIXI.VideoResource;
}

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeFilename(name: string): string {
  return (name || "token").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
}

export function userColor(user: FoundryUser): string {
  const c = user.color as { css?: string } | string | undefined;
  if (typeof c === "string") return c;
  return c?.css ?? String(c ?? "#888888");
}
