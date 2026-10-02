import { zipSync } from "fflate";
import { h, icon, replay } from "./dom";
import { lines, mascot, pick, toast } from "./fun";

const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

export interface DropzoneOptions {
  multiple: boolean;
  /** Which files to take (default: PDFs) and the file-picker filter. */
  accept?: { test: (f: File) => boolean; picker: string; what: string };
  /** Offer a "choose a folder" button (multi-file tools only). */
  folder?: boolean;
  title: string;
  onFiles: (files: File[]) => void;
}

/** A drag-and-drop area that also accepts whole folders. */
export function dropzone(opts: DropzoneOptions): HTMLElement {
  const accept = opts.accept ?? { test: isPdf, picker: "application/pdf,.pdf", what: "PDF" };
  const fileInput = h("input", { type: "file", accept: accept.picker, multiple: opts.multiple, hidden: true });
  const folderInput = h("input", { type: "file", multiple: true, hidden: true });
  folderInput.setAttribute("webkitdirectory", "");

  const deliver = (files: File[]) => {
    const pdfs = files.filter(accept.test).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const skipped = files.length - pdfs.length;
    if (skipped > 0) toast(`Skipped ${skipped} file${skipped === 1 ? "" : "s"} that ${skipped === 1 ? `isn't a ${accept.what}` : `aren't ${accept.what}s`}.`);
    if (pdfs.length === 0) return;
    replay(zone, "gulp");
    opts.onFiles(opts.multiple ? pdfs : pdfs.slice(0, 1));
  };

  for (const input of [fileInput, folderInput]) {
    input.addEventListener("change", () => {
      deliver([...(input.files ?? [])]);
      input.value = "";
    });
  }

  const browse = h("button.link", { type: "button", onclick: () => fileInput.click() }, opts.multiple ? "browse files" : "browse");
  const zone = h(
    "div.dropzone",
    { tabindex: 0, role: "button", "aria-label": `${opts.title}. Press Enter to choose files.` },
    h("div.dz-icon", {}, icon("upload")),
    h("p.dz-title", {}, opts.title),
    h(
      "p.dz-sub",
      {},
      "Drag & drop, or ",
      browse,
      opts.folder ? " · " : "",
      opts.folder && h("button.link", { type: "button", onclick: () => folderInput.click() }, "choose a folder"),
    ),
    fileInput,
    folderInput,
  );

  zone.addEventListener("click", (e) => {
    if (e.target === zone || !(e.target as Element).closest("button")) fileInput.click();
  });
  zone.addEventListener("keydown", (e) => {
    if (e.target === zone && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      fileInput.click();
    }
  });

  let depth = 0;
  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (depth++ === 0) {
      zone.classList.add("over");
      mascot.mood("nom");
      mascot.say(pick(lines.nom));
    }
  });
  zone.addEventListener("dragover", (e) => e.preventDefault());
  zone.addEventListener("dragleave", () => {
    if (--depth === 0) {
      zone.classList.remove("over");
      mascot.mood("idle");
    }
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove("over");
    mascot.mood("idle");
    deliver(await filesFromDrop(e.dataTransfer));
  });
  return zone;
}

/** Collects dropped files, walking into dropped folders. */
async function filesFromDrop(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) return [...dt.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in batches until it returns an empty list.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

export async function readBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function saveFile(bytes: Uint8Array | Blob, name: string): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function saveZip(files: { name: string; bytes: Uint8Array }[], zipName: string): void {
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  const names = uniqueNames(files.map((f) => f.name));
  files.forEach((f, i) => (entries[names[i]] = [f.bytes, { level: 0 }]));
  saveFile(new Blob([zipSync(entries) as BlobPart], { type: "application/zip" }), zipName);
}

/** "a.pdf", "a.pdf" -> "a.pdf", "a (2).pdf" */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    return n === 1 ? name : name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
  });
}

export const baseName = (name: string): string => name.replace(/\.pdf$/i, "");

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
