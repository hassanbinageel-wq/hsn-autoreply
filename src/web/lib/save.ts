import { isNative } from "../platform";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Saves a generated file. In the browser: a normal download. In the Android app a WebView cannot download
 * blob: links, so the file is written to the app cache and handed to the Android share sheet
 * (save to Files / Drive, or share straight to Instagram, WhatsApp…).
 */
export async function saveFile(blob: Blob, filename: string, title = filename): Promise<void> {
  if (isNative) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
    const w = await Filesystem.writeFile({ path: filename, data: await blobToBase64(blob), directory: Directory.Cache });
    await Share.share({ title, files: [w.uri], dialogTitle: title });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
