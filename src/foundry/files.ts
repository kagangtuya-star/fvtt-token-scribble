/**
 * Server file access for replace mode, through Foundry's own FilePicker API
 * (so uploads go through the server's permission checks and storage setup).
 * Only the "data" storage is used.
 */

const SOURCE = "data";

function filePicker(): FilePickerStatic | null {
  return CONFIG.ux?.FilePicker ?? foundry.applications.apps?.FilePicker?.implementation ?? null;
}

/** Can this user create folders and upload files (core permissions)? */
export function canUseFiles(user: FoundryUser = game.user): boolean {
  return !!filePicker() && user.can("FILES_UPLOAD") && user.can("FILES_BROWSE");
}

/** Create `path` and any missing parent folders below `worlds/<id>`. */
export async function ensureFolder(path: string): Promise<void> {
  const fp = filePicker();
  if (!fp) throw new Error("FilePicker unavailable");
  const parts = path.split("/").filter(Boolean);
  // `worlds/<id>` always exists; start below it.
  for (let i = 3; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    try {
      await fp.browse(SOURCE, dir);
    } catch {
      try {
        await fp.createDirectory(SOURCE, dir);
      } catch (err) {
        // A concurrent client may have created it in between.
        try {
          await fp.browse(SOURCE, dir);
        } catch {
          throw err;
        }
      }
    }
  }
}

/** Upload `file` into `folder`; resolves the stored path. */
export async function uploadFile(folder: string, file: File): Promise<string> {
  const fp = filePicker();
  if (!fp) throw new Error("FilePicker unavailable");
  const res = await fp.upload(SOURCE, folder, file, {}, { notify: false });
  const path = res && typeof res === "object" ? res.path : undefined;
  if (!path) throw new Error(`Upload of ${file.name} failed`);
  return path;
}

/** Download an image the client can already see (same origin or CORS-enabled). */
export async function fetchBlob(src: string): Promise<Blob> {
  const res = await fetch(src, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${src}`);
  return res.blob();
}

/** Does `src` still resolve? (HEAD request; any failure counts as missing.) */
export async function srcExists(src: string): Promise<boolean> {
  if (!src) return false;
  try {
    const res = await fetch(src, { method: "HEAD", cache: "no-cache" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Decode an image for drawing onto a canvas without tainting it. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Same-origin files ignore this; remote art must allow CORS or export would fail later.
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}
