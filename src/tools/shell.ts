// The common frame for tools that work on one PDF: drop (or paste a link),
// password gate, file card, the tool's own controls, and a result card.
import { pdf, PdfError } from "../core/client";
import type { PageSize, PdfInput } from "../core/pdf";
import { h, icon } from "../ui/dom";
import { baseName, dropzone, formatSize, plural, readBytes, saveFile } from "../ui/files";
import { celebrate, mascot, oops, reveal } from "../ui/fun";
import { closeSession } from "../ui/thumbs";

export interface Loaded {
  file: File;
  bytes: Uint8Array;
  password?: string;
  session: number;
  pages: PageSize[];
  /** The input every engine call takes. */
  input: PdfInput;
}

export interface Host {
  doc: Loaded;
  /** Shows the finished file with a download button. */
  result(bytes: Uint8Array, name: string, note?: string): void;
  /** Runs work with the mascot busy, reporting failures kindly. Resolves to undefined on failure. */
  work<T>(task: Promise<T>, fail?: string): Promise<T | undefined>;
  /** Re-opens the loaded file from new bytes (e.g. to carry on editing a result). */
  reload(bytes: Uint8Array, name?: string): Promise<void>;
}

export interface ShellOptions {
  id: string;
  title: string;
  intro: string;
  drop: string;
  /** Builds the controls for a loaded file. */
  mount(host: Host): HTMLElement | HTMLElement[];
  /** Called when the file is cleared or replaced. */
  unmount?(): void;
  /** A tool that wants the whole width for its own viewer. */
  wide?: boolean;
}

/** Fetches a PDF from a link. Fails kindly when the other site doesn't allow it. */
export async function fetchPdf(link: string): Promise<File> {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error("That doesn't look like a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https links work.");
  let res: Response;
  try {
    res = await fetch(url, { mode: "cors" });
  } catch {
    throw new Error("That site doesn't let other pages fetch its files. Download it there, then drop it here.");
  }
  if (!res.ok) throw new Error(`The link answered ${res.status}.`);
  const blob = await res.blob();
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "linked.pdf");
  return new File([blob], /\.pdf$/i.test(name) ? name : `${name || "linked"}.pdf`, { type: "application/pdf" });
}

/** A "paste a link" row for tools that open files. */
export function linkRow(onFile: (file: File) => void): HTMLElement {
  const input = h("input.input", { type: "url", placeholder: "…or paste a link to a PDF", "aria-label": "Link to a PDF", spellcheck: false });
  const go = h("button.btn", { type: "submit" }, icon("convert"), "Open link");
  const form = h("form.link-row", {}, input, go);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    go.disabled = true;
    try {
      onFile(await mascot.busy(fetchPdf(input.value)));
      input.value = "";
    } catch (err) {
      oops(err instanceof Error ? err.message : "Couldn't open that link.");
    } finally {
      go.disabled = false;
    }
  });
  return form;
}

export function singleFileTool(opts: ShellOptions): HTMLElement {
  let doc: Loaded | undefined;
  const workspace = h("div.tool-workspace", { hidden: true });
  const body = h("div.tool-body");
  const results = h("div.result-slot");
  const zone = dropzone({ multiple: false, title: opts.drop, onFiles: ([f]) => void load(f) });
  const link = linkRow((f) => void load(f));

  async function load(file: File, password?: string, bytes?: Uint8Array) {
    bytes ??= await readBytes(file);
    try {
      const { session, pages } = await pdf.open({ bytes, password });
      clear();
      doc = { file, bytes, password, session, pages, input: { bytes, password } };
      zone.hidden = link.hidden = true;
      results.replaceChildren();
      show();
    } catch (err) {
      if (err instanceof PdfError && err.kind === "password") askPassword(file, bytes, !!password);
      else oops(err instanceof Error ? err.message : "Couldn't open that file.");
    }
  }

  function askPassword(file: File, bytes: Uint8Array, wrong: boolean) {
    const input = h("input.input", { type: "password", placeholder: "Opening password", "aria-label": "Opening password" });
    const form = h(
      "form.password-gate",
      {},
      icon("key"),
      h("div", {}, h("strong", {}, file.name), h("p", {}, wrong ? "Eish, wrong password. Try again?" : "This one needs its opening password.")),
      input,
      h("button.btn.primary", { type: "submit" }, "Open"),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void load(file, input.value, bytes);
    });
    workspace.hidden = false;
    workspace.replaceChildren(form);
    input.focus();
  }

  const host: Host = {
    get doc() {
      return doc!;
    },
    result(bytes, name, note) {
      results.replaceChildren(
        h(
          "div.result-card",
          {},
          h("div.result-icon", {}, icon("file")),
          h("div.file-main", {}, h("div.file-name", {}, name), h("div.file-meta", {}, [formatSize(bytes.byteLength), note].filter(Boolean).join(" · "))),
          h("button.btn.primary", { type: "button", onclick: () => saveFile(bytes, name) }, icon("download"), "Download"),
          h("button.btn.ghost", { type: "button", title: "Keep working on this result", onclick: () => void host.reload(bytes, name) }, "Keep working on it"),
        ),
      );
      reveal(results);
      celebrate(undefined, results);
    },
    async work(task, fail = "Something went wrong.") {
      try {
        return await mascot.busy(task);
      } catch (err) {
        oops(err instanceof PdfError ? err.message : err instanceof Error && err.message ? err.message : fail);
        return undefined;
      }
    },
    async reload(bytes, name) {
      const file = new File([bytes as BlobPart], name ?? doc?.file.name ?? "result.pdf", { type: "application/pdf" });
      await load(file, undefined, bytes);
    },
  };

  function show() {
    if (!doc) return;
    const d = doc;
    const mounted = opts.mount(host);
    body.replaceChildren(...(Array.isArray(mounted) ? mounted : [mounted]));
    workspace.hidden = false;
    workspace.replaceChildren(
      h(
        "div.doc-card",
        {},
        h("div.result-icon", {}, icon("file")),
        h("div.file-main", {}, h("div.file-name", {}, d.file.name), h("div.file-meta", {}, `${plural(d.pages.length, "page")} · ${formatSize(d.bytes.byteLength)}`)),
        h("button.btn.ghost", { type: "button", onclick: reset }, "Change file"),
      ),
      body,
    );
  }

  function clear() {
    if (doc) {
      opts.unmount?.();
      closeSession(doc.session);
      doc = undefined;
    }
  }

  function reset() {
    clear();
    zone.hidden = link.hidden = false;
    workspace.hidden = true;
    workspace.replaceChildren();
    results.replaceChildren();
  }

  // #read?url=https://… opens that link straight away.
  const [route, query = ""] = location.hash.slice(1).split("?");
  const linked = route === opts.id ? new URLSearchParams(query).get("url") : null;
  if (linked) {
    queueMicrotask(async () => {
      try {
        await load(await mascot.busy(fetchPdf(linked)));
      } catch (err) {
        oops(err instanceof Error ? err.message : "Couldn't open that link.");
      }
    });
  }

  return h(
    `section.tool${opts.wide ? ".wide" : ""}` as "section",
    { id: `tool-${opts.id}` },
    h("div.tool-head", {}, h("h2", {}, opts.title), h("p", {}, opts.intro)),
    zone,
    link,
    workspace,
    results,
  );
}

export { baseName };
