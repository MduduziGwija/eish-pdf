import { pdf, PdfError } from "../core/client";
import type { PdfInfo } from "../core/pdf";
import { fill, h, icon, replay, sleep } from "../ui/dom";
import { baseName, dropzone, formatSize, plural, readBytes, saveFile, saveZip } from "../ui/files";
import { celebrate, mascot, oops, toast } from "../ui/fun";

type State = "checking" | "ready" | "working" | "done" | "free" | "error";

interface Item {
  id: number;
  file: File;
  bytes: Uint8Array;
  info?: PdfInfo;
  password?: string;
  state: State;
  result?: Uint8Array;
  error?: string;
  row: HTMLElement;
}

const BADGE: Record<State, string> = {
  checking: "Checking…",
  ready: "Locked down",
  working: "Unlocking…",
  done: "Unlocked!",
  free: "Already free",
  error: "Eish",
};

export function unlockTool(): HTMLElement {
  let items: Item[] = [];
  let nextId = 1;

  const list = h("ul.file-list", { "aria-label": "Files to unlock" });
  const summary = h("div.summary");
  const bulkPw = h("input.input", { type: "password", placeholder: "Password for locked files", "aria-label": "Password to try on all files that need one" });
  const bulkPwForm = h(
    "form.bulk-password",
    { hidden: true },
    icon("key"),
    bulkPw,
    h("button.btn.ghost", { type: "submit" }, "Try on all"),
  );
  const unlockBtn = h("button.btn.primary.big", { type: "button" }, icon("lock"), h("span", {}, "Unlock all"));
  const zipBtn = h("button.btn", { type: "button", hidden: true }, icon("download"), "Download all (.zip)");
  const logBtn = h("button.btn.ghost", { type: "button", hidden: true }, "Save log (.csv)");
  const clearBtn = h("button.btn.ghost", { type: "button" }, "Clear");
  const toolbar = h("div.toolbar", { hidden: true }, summary, h("div.actions", {}, clearBtn, logBtn, zipBtn, unlockBtn));

  const zone = dropzone({
    multiple: true,
    folder: true,
    title: "Drop your stubborn PDFs here",
    onFiles: (files) => void add(files),
  });

  async function add(files: File[]) {
    const fresh: Item[] = [];
    for (const file of files) {
      const item: Item = { id: nextId++, file, bytes: await readBytes(file), state: "checking", row: h("li.file") };
      item.row.style.setProperty("--i", String(fresh.length % 12));
      fresh.push(item);
      items.push(item);
      render(item);
      list.append(item.row);
    }
    refresh();
    for (const item of fresh) await check(item);
  }

  async function check(item: Item) {
    try {
      item.info = await pdf.inspect({ bytes: item.bytes, password: item.password });
      if (item.info.status === "password") {
        item.state = "error";
        item.error = item.info.wrongPassword ? "Wrong password, try again" : "Needs a password to open";
      } else {
        item.state = item.info.status === "unrestricted" ? "free" : "ready";
        item.error = undefined;
      }
    } catch (err) {
      item.state = "error";
      item.error = err instanceof Error ? err.message : String(err);
    }
    render(item);
    refresh();
  }

  function render(item: Item) {
    const { info } = item;
    const needsPw = info?.status === "password";
    const meta = [
      info && info.pages ? plural(info.pages, "page") : null,
      formatSize(item.file.size),
      info?.restrictions.length ? `Blocks: ${info.restrictions.join(", ")}` : null,
    ].filter(Boolean);

    let pwField: HTMLFormElement | false = false;
    if (needsPw) {
      const input = h("input.input.small", { type: "password", placeholder: "Opening password", "aria-label": `Password for ${item.file.name}` });
      pwField = h("form.row-password", {}, input, h("button.btn.small", { type: "submit" }, "Open"));
      pwField.addEventListener("submit", (e) => {
        e.preventDefault();
        item.password = input.value;
        item.state = "checking";
        render(item);
        void check(item);
      });
    }

    item.row.dataset.state = needsPw ? "password" : item.state;
    fill(item.row, 
      h("div.file-icon", {}, icon("lock")),
      h(
        "div.file-main",
        {},
        h("div.file-name", { title: item.file.name }, item.file.name),
        h("div.file-meta", {}, item.error ?? meta.join(" · ")),
        pwField,
      ),
      h("span.badge", {}, needsPw ? "Needs password" : BADGE[item.state]),
      item.result &&
        h("button.icon-btn", { type: "button", title: "Download", "aria-label": `Download ${item.file.name}`, onclick: () => saveFile(item.result!, `${baseName(item.file.name)}-unlocked.pdf`) }, icon("download")),
      h("button.icon-btn.subtle", { type: "button", title: "Remove", "aria-label": `Remove ${item.file.name}`, onclick: () => remove(item) }, icon("x")),
    );
  }

  function remove(item: Item) {
    item.row.classList.add("leaving");
    item.row.addEventListener("animationend", () => item.row.remove(), { once: true });
    setTimeout(() => item.row.remove(), 500);
    items = items.filter((i) => i !== item);
    refresh();
  }

  function refresh() {
    const count = (s: State) => items.filter((i) => i.state === s).length;
    const locked = count("ready");
    const done = count("done");
    const needPw = items.filter((i) => i.info?.status === "password").length;
    toolbar.hidden = items.length === 0;
    zone.classList.toggle("compact", items.length > 0);
    bulkPwForm.hidden = needPw === 0;
    zipBtn.hidden = done === 0;
    logBtn.hidden = done === 0;
    unlockBtn.disabled = locked === 0 || items.some((i) => i.state === "working" || i.state === "checking");
    fill(summary, 
      chip(plural(items.length, "file"), ""),
      locked > 0 && chip(`${locked} locked`, "warn"),
      needPw > 0 && chip(`${needPw} need a password`, "bad"),
      done > 0 && chip(`${done} unlocked`, "good"),
      count("free") > 0 && chip(`${count("free")} already free`, ""),
    );
  }

  unlockBtn.addEventListener("click", async () => {
    const queue = items.filter((i) => i.state === "ready");
    if (queue.length === 0) return;
    unlockBtn.disabled = true;
    let ok = 0;
    await mascot.busy(
      (async () => {
        for (const item of queue) {
          item.state = "working";
          render(item);
          try {
            const [result] = await Promise.all([pdf.unlock({ bytes: item.bytes, password: item.password }), sleep(260)]);
            item.result = result;
            item.state = "done";
            ok++;
            render(item);
            replay(item.row, "unlocked");
          } catch (err) {
            item.state = "error";
            item.error = err instanceof PdfError ? err.message : "Something went wrong with this file.";
            render(item);
            replay(item.row, "shake");
          }
          refresh();
        }
      })(),
    );
    if (ok > 0) celebrate(ok === 1 ? "Lekker! Unlocked." : `Lekker! ${ok} files unlocked.`, unlockBtn);
    else oops("Couldn't unlock those files.");
    refresh();
  });

  zipBtn.addEventListener("click", () => {
    const done = items.filter((i) => i.result);
    if (done.length === 1) return saveFile(done[0].result!, `${baseName(done[0].file.name)}-unlocked.pdf`);
    saveZip(done.map((i) => ({ name: i.file.name, bytes: i.result! })), "eish-pdf-unlocked.zip");
    toast(`Zipped ${plural(done.length, "file")}. Sharp!`, "ok");
  });

  logBtn.addEventListener("click", () => {
    const rows = [["File", "Pages", "Before", "Restrictions removed", "Result", "Time"]];
    const now = new Date().toISOString();
    for (const i of items) {
      rows.push([
        i.file.name,
        String(i.info?.pages ?? ""),
        i.info?.status === "password" ? "Needs password" : i.info?.status === "restricted" ? "Restricted" : "Unrestricted",
        i.info?.restrictions.join("; ") ?? "",
        i.state === "done" ? "Unlocked" : i.state === "free" ? "No change needed" : (i.error ?? "Not processed"),
        now,
      ]);
    }
    const csv = rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")).join("\r\n");
    saveFile(new Blob([csv], { type: "text/csv" }), `eish-pdf-unlock-log-${now.slice(0, 10)}.csv`);
  });

  clearBtn.addEventListener("click", () => {
    items = [];
    list.replaceChildren();
    refresh();
  });

  bulkPwForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!bulkPw.value) return;
    for (const item of items.filter((i) => i.info?.status === "password")) {
      item.password = bulkPw.value;
      item.state = "checking";
      render(item);
      void check(item);
    }
  });

  return h(
    "section.tool",
    { id: "tool-unlock" },
    h("div.tool-head", {}, h("h2", {}, "Unlock PDFs"), h("p", {}, "Remove print, copy and edit restrictions from loads of PDFs at once.")),
    zone,
    h(
      "p.fine-print",
      {},
      icon("shield"),
      "Only unlock files you're allowed to. Opening passwords are never guessed — if a file needs one, you type it.",
    ),
    toolbar,
    bulkPwForm,
    list,
  );
}

function chip(text: string, kind: string): HTMLElement {
  return h(`span.chip${kind ? "." + kind : ""}`, {}, text);
}
