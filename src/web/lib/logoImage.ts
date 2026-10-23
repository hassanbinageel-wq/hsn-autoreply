/** Resizes an image file to a small square logo (data URL) so it stays light in the database. */
export async function logoDataUrl(file: File, size = 160): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("اختر صورة PNG أو JPG أو WEBP");
  if (file.size > 8 * 1024 * 1024) throw new Error("الصورة كبيرة جدًا (أكثر من 8 ميقا)");
  // Read as a data: URL — the app's security policy allows data: images but not blob: URLs.
  const src = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("تعذّر قراءة الملف"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("تعذّر قراءة الصورة — جرّب صورة ثانية"));
    i.src = src;
  });
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.min(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  const webp = canvas.toDataURL("image/webp", 0.88);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

