import { h, icon, icons } from "../ui/dom";

interface Tile {
  id: string;
  label: string;
  blurb: string;
  icon: keyof typeof icons;
  tone: string;
}

const TILES: Tile[] = [
  { id: "read", label: "Read", blurb: "Open and view your PDF files instantly.", icon: "eye", tone: "green" },
  { id: "pages", label: "Pages", blurb: "Rearrange, turn or delete pages.", icon: "pages", tone: "gold" },
  { id: "merge", label: "Merge", blurb: "Combine multiple PDFs into one.", icon: "merge", tone: "blue" },
  { id: "split", label: "Split", blurb: "Separate your PDF into multiple files.", icon: "scissors", tone: "purple" },
  { id: "autosplit", label: "Auto split", blurb: "Splits a batch of documents by itself.", icon: "wand", tone: "pink" },
  { id: "compress", label: "Compress", blurb: "Reduce file size without losing quality.", icon: "squeeze", tone: "mint" },
  { id: "edit", label: "Edit", blurb: "Change text, add images and sign.", icon: "pen", tone: "pink" },
  { id: "comments", label: "Comments", blurb: "Notes, highlights and boxes with comments.", icon: "comment", tone: "purple" },
  { id: "forms", label: "Forms", blurb: "Fill in form fields and lock the answers.", icon: "form", tone: "blue" },
  { id: "stamp", label: "Stamp", blurb: "Add a watermark or page numbers.", icon: "stamp", tone: "gold" },
  { id: "redact", label: "Redact", blurb: "Black out private details for good.", icon: "redact", tone: "purple" },
  { id: "ocr", label: "OCR", blurb: "Make scanned pages searchable.", icon: "ocr", tone: "green" },
  { id: "unlock", label: "Unlock", blurb: "Remove print, copy and edit limits.", icon: "lock", tone: "pink" },
  { id: "verify", label: "Signatures", blurb: "See who signed and whether it changed.", icon: "seal", tone: "green" },
  { id: "pdfa", label: "PDF/A", blurb: "Check and prepare for archiving.", icon: "archive", tone: "gold" },
  { id: "protect", label: "Protect", blurb: "Lock a PDF with a password.", icon: "shield", tone: "mint" },
  { id: "convert", label: "Convert", blurb: "Word, Excel and pictures to and from PDF.", icon: "convert", tone: "gold" },
  { id: "compare", label: "Compare", blurb: "See what changed between PDFs.", icon: "compare", tone: "blue" },
];

/** The start page: every tool as a tile, plus a reminder that nothing leaves the device. */
export function homeTool(): HTMLElement {
  const tiles = TILES.map((t, i) => {
    const el = h(
      "a.tile",
      { href: `#${t.id}`, "data-tone": t.tone },
      h("span.tile-icon", {}, icon(t.icon)),
      h("strong", {}, t.label),
      h("span.tile-blurb", {}, t.blurb),
      h("span.tile-go", { "aria-hidden": "true" }, icon("arrow")),
    );
    el.style.setProperty("--i", String(i));
    return el;
  });
  return h(
    "section.tool.home",
    { id: "tool-home" },
    h("div.tool-head", {}, h("h2", {}, "All tools"), h("p", {}, "Pick one, drop your PDF in, and you're sorted.")),
    h("div.tile-grid", {}, ...tiles),
    h(
      "div.home-notes",
      {},
      h("div.note-card", {}, icon("shield"), h("div", {}, h("strong", {}, "Your files stay yours"), h("p", {}, "Everything happens in your browser. Nothing is uploaded, and nothing is saved."))),
      h("div.note-card.quote", {}, h("div", {}, h("strong", {}, "“Small files, big dreams.”"), h("p", {}, "Eish PDF"))),
    ),
  );
}
