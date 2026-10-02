// Pictures the PDF engine can't read itself (WebP, AVIF, SVG…) are decoded by
// the browser and handed over as PNG.

/** Formats MuPDF reads directly. */
export const ENGINE_IMAGES = /\.(png|jpe?g|gif|bmp|tiff?|jpx|jp2|pnm|pbm|pgm|ppm|pam)$/i;

export async function browserImageToPng(file: File): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    // SVGs without a size come out tiny; give them a sensible minimum.
    const scale = img.naturalWidth < 600 && /\.svg$/i.test(file.name) ? 600 / Math.max(1, img.naturalWidth) : 1;
    const w = Math.max(1, Math.round((img.naturalWidth || 800) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 600) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("couldn't encode");
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    throw new Error("Your browser can't open this picture.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
