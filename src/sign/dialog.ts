// The optional "Digital signature (certificate)" dialog. Loads a .p12/.pfx or
// creates a test certificate; nothing is stored or uploaded.
import { h } from "../ui/dom";
import { saveFile } from "../ui/files";
import type { Identity } from "./certificate";

export interface CertSettings {
  identity: Identity;
  reason: string;
  location: string;
  /** Show the signature box on the page (over the placed signature picture). */
  visible: boolean;
}

const fmtDate = (d: Date) => d.toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" });

export function openCertificateDialog(current: CertSettings | undefined, hasSignaturePicture: boolean): Promise<CertSettings | null | "off"> {
  return new Promise((resolve) => {
    let tab: "mine" | "test" = "mine";
    let identity: Identity | undefined = current?.identity;
    let busy = false;

    const error = h("p.sig-error", { role: "alert" });
    const body = h("div.sig-body");
    const tabs = h("div.segments.compact.sig-tabs", { role: "tablist" });
    const reason = h("input.input", { type: "text", value: current?.reason ?? "I approve this document", "aria-label": "Reason for signing", maxlength: 120 });
    const location = h("input.input", { type: "text", value: current?.location ?? "", placeholder: "e.g. Pretoria", "aria-label": "Where you're signing", maxlength: 80 });
    const visible = h("input", { type: "checkbox", checked: current?.visible ?? hasSignaturePicture, disabled: !hasSignaturePicture });
    const useBtn = h("button.btn.primary", { type: "button" }, "Sign when saving");
    const offBtn = h("button.btn.ghost", { type: "button", hidden: !current }, "Turn off");
    const cancelBtn = h("button.btn.ghost", { type: "button" }, "Cancel");
    const summary = h("div.cert-summary");

    const forge = () => import("./certificate");

    function showIdentity() {
      if (!identity) {
        summary.replaceChildren();
        useBtn.disabled = true;
        return;
      }
      useBtn.disabled = false;
      summary.replaceChildren(
        h(
          "div.cert-card",
          {},
          h("div.cert-seal", { "aria-hidden": "true" }, "🔏"),
          h(
            "div",
            {},
            h("strong", {}, identity.name),
            h("div.file-meta", {}, `Issued by ${identity.issuer} · valid until ${fmtDate(identity.validTo)}`),
            identity.selfSigned && h("div.cert-warn", {}, "Test (self-signed) certificate: viewers will say they can't verify who signed, but will still show the document hasn't changed since."),
          ),
        ),
        h("label.option.stack", {}, h("span", {}, "Reason"), reason),
        h("label.option.stack", {}, h("span", {}, "Location (optional)"), location),
        h(
          "label.check",
          {},
          visible,
          h("span", {}, hasSignaturePicture ? "Show the signature on the page (on your placed signature)" : "Place a signature with ✍ Sign first to show it on the page; otherwise it's an invisible signature"),
        ),
      );
    }

    function renderTabs() {
      tabs.replaceChildren(
        ...(["mine", "test"] as const).map((t) =>
          h(
            "button.segment",
            { type: "button", role: "tab", "aria-selected": String(tab === t), "aria-pressed": String(tab === t), onclick: () => ((tab = t), renderTabs()) },
            h("strong", {}, t === "mine" ? "Use my certificate" : "Create a test certificate"),
            h("span", {}, t === "mine" ? ".p12 or .pfx file" : "To try it out"),
          ),
        ),
      );
      error.textContent = "";
      if (tab === "mine") {
        const file = h("input", { type: "file", accept: ".p12,.pfx,application/x-pkcs12", "aria-label": "Certificate file" });
        const pw = h("input.input", { type: "password", placeholder: "Certificate password", "aria-label": "Certificate password", autocomplete: "off" });
        const open = h("button.btn", { type: "button" }, "Open certificate");
        open.addEventListener("click", async () => {
          const f = file.files?.[0];
          if (!f) return void (error.textContent = "Choose your .p12 or .pfx file first.");
          try {
            const { loadIdentity } = await forge();
            identity = loadIdentity(new Uint8Array(await f.arrayBuffer()), pw.value);
            error.textContent = "";
            showIdentity();
          } catch (err) {
            error.textContent = err instanceof Error ? err.message : "Couldn't open that certificate.";
          }
        });
        body.replaceChildren(
          h("p.hint", {}, "Your certificate and password stay on this device. They're only used to sign, and are forgotten when you close the page."),
          h("div.sig-row", {}, file),
          h("div.sig-row", {}, pw, open),
        );
      } else {
        const name = h("input.input", { type: "text", placeholder: "Your full name", "aria-label": "Your full name", maxlength: 80 });
        const email = h("input.input", { type: "email", placeholder: "Email (optional)", "aria-label": "Email", maxlength: 120 });
        const pw = h("input.input", { type: "password", placeholder: "Password for the certificate file", "aria-label": "Password for the certificate file", autocomplete: "new-password" });
        const make = h("button.btn", { type: "button" }, "Create certificate");
        make.addEventListener("click", async () => {
          if (busy) return;
          if (!name.value.trim()) return void (error.textContent = "Type your name first.");
          if (pw.value.length < 6) return void (error.textContent = "Choose a password of at least 6 characters, to protect the certificate file.");
          busy = true;
          make.textContent = "Creating…";
          try {
            const { createTestIdentity } = await forge();
            const made = await createTestIdentity(name.value.trim(), email.value.trim(), pw.value);
            identity = made.identity;
            saveFile(new Blob([made.p12 as BlobPart], { type: "application/x-pkcs12" }), `${name.value.trim().replace(/[^\w-]+/g, "-")}-test-certificate.p12`);
            error.textContent = "";
            showIdentity();
          } catch (err) {
            error.textContent = err instanceof Error ? err.message : "Couldn't create the certificate.";
          } finally {
            busy = false;
            make.textContent = "Create certificate";
          }
        });
        body.replaceChildren(
          h("p.hint", {}, "Makes a certificate in your name and downloads it (.p12) so you can use it again. For official documents, use a certificate from your organisation or a trusted provider."),
          name,
          email,
          h("div.sig-row", {}, pw, make),
        );
      }
    }

    const overlay = h(
      "div.modal-backdrop",
      {},
      h(
        "div.modal.cert-modal",
        { role: "dialog", "aria-modal": "true", "aria-label": "Digital signature with a certificate" },
        h("h3", {}, "🔏 Digital signature (optional)"),
        h("p.hint", {}, "Seals the PDF with your certificate. PDF readers like Adobe show who signed it, and warn if anything changes afterwards."),
        tabs,
        body,
        summary,
        error,
        h("div.sig-actions", {}, offBtn, cancelBtn, useBtn),
      ),
    );

    const close = (result: CertSettings | null | "off") => {
      overlay.classList.add("leaving");
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      }
    };
    useBtn.addEventListener("click", () => {
      if (!identity) return;
      close({ identity, reason: reason.value.trim(), location: location.value.trim(), visible: visible.checked && hasSignaturePicture });
    });
    offBtn.addEventListener("click", () => close("off"));
    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);

    renderTabs();
    showIdentity();
    document.body.append(overlay);
  });
}
