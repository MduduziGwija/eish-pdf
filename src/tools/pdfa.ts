import { pdf } from "../core/client";
import type { PdfaReport } from "../core/pageops";
import { h, icon } from "../ui/dom";
import { baseName } from "../ui/files";
import { singleFileTool } from "./shell";

const MARK = { ok: "Yes", fixable: "Fixable", blocker: "Can't fix" } as const;

export function pdfaTool(): HTMLElement {
  return singleFileTool({
    id: "pdfa",
    title: "Archive (PDF/A)",
    intro: "Check whether a PDF is ready for long-term archiving, and repair what can be repaired.",
    drop: "Drop a PDF to check",
    mount(host) {
      const { doc } = host;
      const out = h("div.sig-list", {}, h("p.fine-print", {}, "Checking…"));
      const actions = h("div.actions");
      void pdf.checkPdfa(doc.input).then((r: PdfaReport) => {
        out.replaceChildren(
          ...r.findings.map((f) => h("div.check-row", { "data-state": f.state }, h("span.badge", {}, MARK[f.state]), h("div", {}, h("strong", {}, f.title), h("p.fine-print", {}, f.detail)))),
        );
        const prepare = h("button.btn.primary.big", { type: "button", disabled: !r.fixable }, icon("archive"), h("span", {}, "Prepare as PDF/A"));
        prepare.addEventListener("click", async () => {
          const bytes = await host.work(pdf.preparePdfa(doc.input), "Couldn't prepare this file.");
          if (bytes) host.result(bytes, `${baseName(doc.file.name)}-pdfa.pdf`, "PDF/A-2b prepared");
        });
        actions.append(prepare);
        if (!r.fixable) {
          const flat = h("button.btn.big", { type: "button" }, icon("copy"), h("span", {}, "Turn pages into pictures, then prepare"));
          flat.addEventListener("click", async () => {
            const bytes = await host.work(
              (async () => pdf.preparePdfa({ bytes: await pdf.flatten(doc.input, 200) }))(),
              "Couldn't flatten this file.",
            );
            if (bytes) host.result(bytes, `${baseName(doc.file.name)}-pdfa.pdf`, "Pages are pictures now (no selectable text)");
          });
          actions.append(flat);
        }
      });
      return [
        out,
        h("div.toolbar", {}, h("span.fine-print", {}, icon("shield"), "A best-effort repair, not a certificate. Run a strict checker such as veraPDF if you must prove compliance."), actions),
      ];
    },
  });
}
