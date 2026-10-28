import { pdf } from "../core/client";
import type { SignatureReport } from "../sign/validate";
import { h, icon } from "../ui/dom";
import { plural } from "../ui/files";
import { singleFileTool } from "./shell";

const WORDS = { valid: "Good", "later-changes": "Edited since", invalid: "Not valid" } as const;
const date = (d?: Date) => (d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "unknown");

export function verifyTool(): HTMLElement {
  return singleFileTool({
    id: "verify",
    title: "Check signatures",
    intro: "See who signed a PDF, when, and whether anything changed after they signed it.",
    drop: "Drop a signed PDF to check",
    mount(host) {
      const { doc } = host;
      const out = h("div.sig-list", {}, h("p.fine-print", {}, "Checking…"));
      void pdf.validateSignatures(doc.bytes).then((reports: SignatureReport[]) => {
        if (reports.length === 0) {
          out.replaceChildren(h("div.panel-card", {}, h("h3", {}, "No signatures"), h("p.fine-print", {}, "This PDF has no certificate signatures. To sign one, use the Edit tool.")));
          return;
        }
        out.replaceChildren(
          h("span.chip", {}, plural(reports.length, "signature")),
          ...reports.map((r) =>
            h(
              "div.panel-card.sig",
              { "data-status": r.status },
              h("div.sig-head", {}, icon("seal"), h("div", {}, h("h3", {}, r.signer), h("p.fine-print", {}, [r.email, `issued by ${r.issuer}`].filter(Boolean).join(" · "))), h("span.badge", {}, WORDS[r.status])),
              h(
                "dl.sig-facts",
                {},
                h("dt", {}, "Signed"),
                h("dd", {}, date(r.signedAt)),
                r.reason && h("dt", {}, "Reason"),
                r.reason && h("dd", {}, r.reason),
                r.location && h("dt", {}, "Place"),
                r.location && h("dd", {}, r.location),
                h("dt", {}, "Certificate valid"),
                h("dd", {}, `${date(r.validFrom)} to ${date(r.validTo)}`),
                h("dt", {}, "Fingerprint"),
                h("dd", {}, r.hash),
              ),
              h("ul.sig-notes", {}, ...r.notes.map((n) => h("li", {}, n))),
            ),
          ),
        );
      });
      return [out, h("p.fine-print", {}, icon("shield"), "Checked on your device. Eish PDF can tell if the file changed and whether the signature is genuine, but has no list of trusted authorities, so it can't promise the signer is who they say.")];
    },
  });
}
