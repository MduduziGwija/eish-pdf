// Preparing a PDF for a certificate (PKCS#7 / CMS) signature: adds a signature
// field whose /Contents is an empty slot, and reports which bytes the
// signature must cover. The signing itself happens elsewhere (with the
// user's certificate); see src/sign/certificate.ts.
import * as mupdf from "mupdf";
import { toUserSpace } from "./text";

/** Room for the signature (bytes). Certificate chains with timestamps fit easily. */
export const SIGNATURE_BYTES = 12000;
// Fixed-width numbers, overwritten in place once the offsets are known (the
// file length must not change, or the PDF's cross-reference table breaks).
const BIG = 1000000000;
const RANGE_PLACEHOLDER = `[0 ${BIG} ${BIG} ${BIG}]`;

export interface SignatureInfo {
  /** Signer's name shown by PDF viewers. */
  name: string;
  reason?: string;
  location?: string;
  contact?: string;
  /** Page (0-based) and box (page space, top-left origin as displayed) for a visible signature; omit for an invisible one. */
  page?: number;
  rect?: [number, number, number, number];
  /** When signing; defaults to now. */
  date?: Date;
}

export interface PreparedPdf {
  bytes: Uint8Array;
  /** The four ByteRange numbers: [start1, length1, start2, length2]. */
  byteRange: [number, number, number, number];
}

const pdfDate = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

const enc = new TextEncoder();

function lastIndexOf(haystack: Uint8Array, needle: string): number {
  const n = enc.encode(needle);
  outer: for (let i = haystack.length - n.length; i >= 0; i--) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

/** Adds an empty signature to a PDF and fills in its ByteRange. */
export function prepareForSigning(input: Uint8Array, info: SignatureInfo): PreparedPdf {
  const doc = new mupdf.PDFDocument(input);
  try {
    if (doc.needsPassword()) throw new Error("Unlock the PDF before signing it.");
    const pageIndex = Math.min(Math.max(0, info.page ?? 0), doc.countPages() - 1);
    const pageObj = doc.findPage(pageIndex);

    // Widget rectangle in PDF user space (empty = invisible signature).
    let rect: number[] = [0, 0, 0, 0];
    if (info.rect) {
      const page = doc.loadPage(pageIndex);
      const map = toUserSpace(page);
      const [x0, y0, x1, y1] = info.rect;
      const a = map.point([x0, y0]);
      const b = map.point([x1, y1]);
      rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      page.destroy();
    }

    const sig = doc.addObject({
      Type: doc.newName("Sig"),
      Filter: doc.newName("Adobe.PPKLite"),
      SubFilter: doc.newName("adbe.pkcs7.detached"),
      Name: doc.newString(info.name),
      M: doc.newString(pdfDate(info.date ?? new Date())),
      ...(info.reason ? { Reason: doc.newString(info.reason) } : {}),
      ...(info.location ? { Location: doc.newString(info.location) } : {}),
      ...(info.contact ? { ContactInfo: doc.newString(info.contact) } : {}),
    });
    // Placeholders, patched after saving: we only know byte offsets then.
    const range = doc.newArray();
    for (const v of [0, BIG, BIG, BIG]) range.push(v);
    sig.put("ByteRange", range);
    sig.put("Contents", doc.newByteString(new Uint8Array(SIGNATURE_BYTES)));

    // Unique field name.
    const catalog = doc.getTrailer().get("Root");
    let form = catalog.get("AcroForm");
    if (form.isNull()) {
      form = doc.addObject({ Fields: doc.newArray() });
      catalog.put("AcroForm", form);
    }
    let fields = form.get("Fields");
    if (fields.isNull()) {
      fields = doc.newArray();
      form.put("Fields", fields);
    }
    let n = 1;
    const names = new Set<string>();
    for (let i = 0; i < fields.length; i++) names.add(fields.get(i).get("T").asString?.() ?? "");
    while (names.has(`Signature${n}`)) n++;

    const widget = doc.addObject({
      Type: doc.newName("Annot"),
      Subtype: doc.newName("Widget"),
      FT: doc.newName("Sig"),
      T: doc.newString(`Signature${n}`),
      F: 132, // Print + Locked
      Rect: rect,
      P: pageObj,
      V: sig,
    });
    fields.push(widget);
    form.put("SigFlags", 3); // SignaturesExist + AppendOnly
    let annots = pageObj.get("Annots");
    if (annots.isNull()) {
      annots = doc.newArray();
      pageObj.put("Annots", annots);
    }
    annots.push(widget);

    const buf = doc.saveToBuffer("garbage,compress");
    let bytes: Uint8Array;
    try {
      bytes = buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
    return patchByteRange(bytes);
  } finally {
    doc.destroy();
  }
}

/** Finds the empty /Contents slot and writes the matching /ByteRange in place. */
function patchByteRange(bytes: Uint8Array): PreparedPdf {
  const zeros = "0".repeat(SIGNATURE_BYTES * 2);
  const contentsAt = lastIndexOf(bytes, `<${zeros}>`);
  const placeholderAt = lastIndexOf(bytes, RANGE_PLACEHOLDER);
  if (contentsAt < 0 || placeholderAt < 0) throw new Error("Couldn't prepare the signature space.");
  const start2 = contentsAt + zeros.length + 2;
  const byteRange: [number, number, number, number] = [0, contentsAt, start2, bytes.length - start2];
  const actual = `[${byteRange.join(" ")}]`.padEnd(RANGE_PLACEHOLDER.length, " ");
  if (actual.length !== RANGE_PLACEHOLDER.length) throw new Error("This PDF is too big to sign.");
  bytes.set(enc.encode(actual), placeholderAt);
  return { bytes, byteRange };
}

/** The bytes a signature covers: everything except the /Contents slot. */
export function signedBytes(prepared: PreparedPdf): Uint8Array {
  const [s1, l1, s2, l2] = prepared.byteRange;
  const out = new Uint8Array(l1 + l2);
  out.set(prepared.bytes.subarray(s1, s1 + l1), 0);
  out.set(prepared.bytes.subarray(s2, s2 + l2), l1);
  return out;
}

/** Writes the DER-encoded CMS signature into the slot. */
export function insertSignature(prepared: PreparedPdf, der: Uint8Array): Uint8Array {
  if (der.length > SIGNATURE_BYTES) throw new Error("The signature is too big for the space reserved for it.");
  const hex = Array.from(der, (b) => b.toString(16).padStart(2, "0")).join("").padEnd(SIGNATURE_BYTES * 2, "0");
  const out = prepared.bytes.slice();
  out.set(enc.encode(hex), prepared.byteRange[1] + 1);
  return out;
}
