// Builds a Word (.docx) file from simple paragraphs, runs and pictures.
// No MuPDF here: it's plain XML zipped with fflate.
import { zipSync, strToU8 } from "fflate";

export interface DocRun {
  text: string;
  /** Points. */
  size: number;
  bold?: boolean;
  italic?: boolean;
  /** "rrggbb" */
  color?: string;
  font?: string;
}

export type DocBlock =
  | { type: "p"; runs: DocRun[]; align?: "left" | "center" | "right"; indent?: number }
  | { type: "img"; png: Uint8Array; width: number; height: number }
  | { type: "pagebreak" };

const EMU_PER_PT = 12700;

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 can't hold.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");

function runXml(r: DocRun): string {
  const props = [
    r.font && `<w:rFonts w:ascii="${esc(r.font)}" w:hAnsi="${esc(r.font)}" w:cs="${esc(r.font)}"/>`,
    r.bold && "<w:b/>",
    r.italic && "<w:i/>",
    r.color && r.color !== "000000" && `<w:color w:val="${r.color}"/>`,
    `<w:sz w:val="${Math.max(2, Math.round(r.size * 2))}"/>`,
  ]
    .filter(Boolean)
    .join("");
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
}

function imageXml(id: number, rel: string, width: number, height: number): string {
  // Keep pictures within an A4 text column (about 451pt wide).
  const scale = Math.min(1, 451 / width);
  const cx = Math.round(width * scale * EMU_PER_PT);
  const cy = Math.round(height * scale * EMU_PER_PT);
  return (
    `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

export function buildDocx(blocks: DocBlock[], title = "Converted with Eish PDF"): Uint8Array {
  const media: Record<string, Uint8Array> = {};
  const rels: string[] = [];
  let body = "";
  let n = 0;
  for (const b of blocks) {
    if (b.type === "pagebreak") {
      body += `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    } else if (b.type === "img") {
      n++;
      const rel = `rIdImg${n}`;
      media[`word/media/image${n}.png`] = b.png;
      rels.push(`<Relationship Id="${rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${n}.png"/>`);
      body += imageXml(n, rel, b.width, b.height);
    } else {
      const ppr = [
        b.align && b.align !== "left" && `<w:jc w:val="${b.align === "center" ? "center" : "right"}"/>`,
        b.indent && b.indent > 0 && `<w:ind w:left="${Math.round(b.indent * 20)}"/>`,
        `<w:spacing w:after="120"/>`,
      ]
        .filter(Boolean)
        .join("");
      body += `<w:p><w:pPr>${ppr}</w:pPr>${b.runs.map(runXml).join("")}</w:p>`;
    }
  }

  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ),
    "docProps/core.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title><dc:creator>Eish PDF</dc:creator></cp:coreProperties>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
    ),
    "word/document.xml": strToU8(document),
    ...media,
  };
  return zipSync(files);
}
