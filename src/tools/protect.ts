import { pdf } from "../core/client";
import type { Properties } from "../core/pageops";
import { h, icon } from "../ui/dom";
import { baseName } from "../ui/files";
import { toast } from "../ui/fun";
import { singleFileTool } from "./shell";

export function protectTool(): HTMLElement {
  return singleFileTool({
    id: "protect",
    title: "Protect a PDF",
    intro: "Lock it with a password (AES-256), choose what people may do, and tidy the document info.",
    drop: "Drop a PDF to lock",
    mount(host) {
      const { doc } = host;
      const pw = h("input.input", { type: "password", placeholder: "Password to open (optional)", autocomplete: "new-password", "aria-label": "Password to open" });
      const owner = h("input.input", { type: "password", placeholder: "Password to change these rules (optional)", autocomplete: "new-password", "aria-label": "Owner password" });
      const box = (label: string, on = true) => {
        const input = h("input", { type: "checkbox", checked: on });
        return { input, el: h("label.check", {}, input, h("span", {}, label)) };
      };
      const print = box("Allow printing");
      const copy = box("Allow copying text");
      const edit = box("Allow editing");
      const note = box("Allow comments and form filling");
      const lock = h("button.btn.primary.big", { type: "button" }, icon("lock"), h("span", {}, "Lock it"));
      lock.addEventListener("click", async () => {
        if (!pw.value && print.input.checked && copy.input.checked && edit.input.checked && note.input.checked) return toast("Give it a password or switch something off first.", "info");
        const bytes = await host.work(
          pdf.protect(doc.input, { openPassword: pw.value, ownerPassword: owner.value, allow: { print: print.input.checked, copy: copy.input.checked, edit: edit.input.checked, annotate: note.input.checked } }),
          "Couldn't lock this file.",
        );
        if (bytes) host.result(bytes, `${baseName(doc.file.name)}-protected.pdf`, pw.value ? "Needs a password to open" : "Opens freely, rules are locked");
      });

      // Document info.
      const fields: Record<keyof Properties, HTMLInputElement> = {
        title: h("input.input", { type: "text", "aria-label": "Title" }),
        author: h("input.input", { type: "text", "aria-label": "Author" }),
        subject: h("input.input", { type: "text", "aria-label": "Subject" }),
        keywords: h("input.input", { type: "text", "aria-label": "Keywords" }),
      };
      void pdf.readProps(doc.input).then((p) => (Object.keys(fields) as (keyof Properties)[]).forEach((k) => (fields[k].value = p[k])));
      const wipe = h("button.btn", { type: "button" }, "Clear all");
      wipe.addEventListener("click", () => Object.values(fields).forEach((f) => (f.value = "")));
      const saveInfo = h("button.btn.primary", { type: "button" }, "Save document info");
      saveInfo.addEventListener("click", async () => {
        const props = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.value])) as unknown as Properties;
        const bytes = await host.work(pdf.writeProps(doc.input, props));
        if (bytes) host.result(bytes, `${baseName(doc.file.name)}-info.pdf`, "Document info updated");
      });
      const row = (label: string, f: HTMLElement) => h("label.option", {}, h("span", {}, label), f);

      return [
        h("div.panel-card", {}, h("h3", {}, "Passwords"), h("div.form-grid", {}, pw, owner), h("div.check-grid", {}, print.el, copy.el, edit.el, note.el), h("div.toolbar", {}, h("span.fine-print", {}, "Don't lose the password, there is no way back."), h("div.actions", {}, lock))),
        h("div.panel-card", {}, h("h3", {}, "Document info"), h("div.form-grid", {}, row("Title", fields.title), row("Author", fields.author), row("Subject", fields.subject), row("Keywords", fields.keywords)), h("div.toolbar", {}, h("span.fine-print", {}, "Shown in other PDF apps. Clear it before sharing if you'd rather not say who made it."), h("div.actions", {}, wipe, saveInfo))),
      ];
    },
  });
}
