import { pdf } from "../core/client";
import type { FormField } from "../core/pageops";
import { h, icon } from "../ui/dom";
import { baseName, plural } from "../ui/files";
import { singleFileTool } from "./shell";

export function formsTool(): HTMLElement {
  return singleFileTool({
    id: "forms",
    title: "Fill in a form",
    intro: "Type into the fields of a fillable PDF. Optionally lock the answers in so they can't be changed.",
    drop: "Drop a fillable PDF",
    mount(host) {
      const { doc } = host;
      const values: Record<string, string> = {};
      const list = h("div.field-list", {}, h("p.fine-print", {}, "Looking for fields…"));
      const flatten = h("input", { type: "checkbox" });
      const go = h("button.btn.primary.big", { type: "button", disabled: true }, icon("form"), h("span", {}, "Save filled form"));
      go.addEventListener("click", async () => {
        const bytes = await host.work(pdf.fillForm(doc.input, values, flatten.checked), "Couldn't fill this form.");
        if (bytes) host.result(bytes, `${baseName(doc.file.name)}-filled.pdf`, flatten.checked ? "Answers locked in" : "Still fillable");
      });

      function control(f: FormField): HTMLElement {
        values[f.id] = f.value;
        const label = f.label || f.name || "Field";
        if (f.kind === "checkbox" || f.kind === "radio") {
          const on = f.value !== "" && f.value !== "Off";
          values[f.id] = on ? "on" : "off";
          const box = h("input", { type: "checkbox", checked: on, disabled: f.readOnly });
          box.addEventListener("change", () => (values[f.id] = box.checked ? "on" : "off"));
          return h("label.check", {}, box, h("span", {}, label));
        }
        let input: HTMLElement;
        if (f.kind === "choice") {
          const sel = h("select.input.select", { "aria-label": label, disabled: f.readOnly });
          for (const o of f.options) sel.append(h("option", { value: o, selected: o === f.value }, o));
          sel.addEventListener("change", () => (values[f.id] = sel.value));
          input = sel;
        } else if (f.multiline) {
          const t = h("textarea.input", { rows: "3", "aria-label": label, disabled: f.readOnly }) as HTMLTextAreaElement;
          t.value = f.value;
          t.addEventListener("input", () => (values[f.id] = t.value));
          input = t;
        } else {
          const i = h("input.input", { type: "text", value: f.value, "aria-label": label, disabled: f.readOnly });
          i.addEventListener("input", () => (values[f.id] = i.value));
          input = i;
        }
        return h("label.option", {}, h("span", {}, label), input);
      }

      void pdf.formFields(doc.input).then((fields) => {
        if (fields.length === 0) {
          list.replaceChildren(h("p.fine-print", {}, icon("shield"), "No fillable fields in this PDF. To type on a normal page, use the Edit tool."));
          return;
        }
        const pages = [...new Set(fields.map((f) => f.page))];
        list.replaceChildren(
          h("span.chip", {}, plural(fields.length, "field")),
          ...pages.map((p) => h("div.panel-card", {}, h("h3", {}, `Page ${p + 1}`), h("div.form-grid", {}, ...fields.filter((f) => f.page === p).map(control)))),
        );
        go.disabled = false;
      });
      return [list, h("div.toolbar", {}, h("label.check", {}, flatten, h("span", {}, "Lock the answers in (can't be edited afterwards)")), h("div.actions", {}, go))];
    },
  });
}
