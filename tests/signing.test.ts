import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";
import { beforeAll, describe, expect, it } from "vitest";
import { insertSignature, prepareForSigning, signedBytes, SIGNATURE_BYTES } from "../src/core/signing";
import { createTestIdentity, loadIdentity, signPrepared, type Identity } from "../src/sign/certificate";
import { makePdf, pageTexts } from "./fixtures";

const hasPdfsig = (() => {
  try {
    execFileSync("pdfsig", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Runs Poppler's pdfsig, an independent signature checker, when it's installed. */
function pdfsig(bytes: Uint8Array): string {
  const file = path.join(os.tmpdir(), `eish-sig-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(file, bytes);
  try {
    return execFileSync("pdfsig", [file], { encoding: "utf8" });
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? err);
  } finally {
    fs.unlinkSync(file);
  }
}

let id: Identity;
let p12: Uint8Array;
beforeAll(async () => {
  ({ identity: id, p12 } = await createTestIdentity("Thandi Nkosi", "thandi@example.co.za", "lekker123"));
}, 30_000);

describe("certificates", () => {
  it("creates a test certificate that can be saved and opened again", () => {
    expect(id.name).toBe("Thandi Nkosi");
    expect(id.email).toBe("thandi@example.co.za");
    expect(id.selfSigned).toBe(true);
    const again = loadIdentity(p12, "lekker123");
    expect(again.name).toBe("Thandi Nkosi");
    expect(again.cert.serialNumber).toBe(id.cert.serialNumber);
  });

  it("explains a wrong password or a file that isn't a certificate", () => {
    expect(() => loadIdentity(p12, "wrong")).toThrow(/password/);
    expect(() => loadIdentity(makePdf(1), "x")).toThrow(/certificate file/);
  });
});

describe("signing PDFs", () => {
  it("covers every byte except the signature itself", () => {
    const prepared = prepareForSigning(makePdf(2), { name: "Thandi Nkosi" });
    const [s1, l1, s2, l2] = prepared.byteRange;
    expect(s1).toBe(0);
    expect(s2 + l2).toBe(prepared.bytes.length);
    expect(s2 - (s1 + l1)).toBe(SIGNATURE_BYTES * 2 + 2); // <hex>
    expect(new TextDecoder().decode(prepared.bytes.subarray(l1, l1 + 1))).toBe("<");
    expect(signedBytes(prepared).length).toBe(l1 + l2);
  });

  it("produces a signature whose digest matches the document", () => {
    const prepared = prepareForSigning(makePdf(1), { name: "Thandi Nkosi", reason: "Approved" });
    const signed = signPrepared(prepared, id);
    const [, l1] = prepared.byteRange;
    const hex = new TextDecoder().decode(signed.subarray(l1 + 1, l1 + 1 + SIGNATURE_BYTES * 2)).replace(/0+$/, "");
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.hexToBytes(hex.length % 2 ? hex + "0" : hex))) as forge.pkcs7.PkcsSignedData & { rawCapture: { authenticatedAttributes: forge.asn1.Asn1[] } };
    const digestAttr = p7.rawCapture.authenticatedAttributes.find((a) => forge.asn1.derToOid((a.value as forge.asn1.Asn1[])[0].value as string) === forge.pki.oids.messageDigest)!;
    const digest = ((digestAttr.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0].value as string;
    const md = forge.md.sha256.create();
    md.update(String.fromCharCode(...signedBytes({ ...prepared, bytes: signed })));
    expect(forge.util.bytesToHex(digest)).toBe(md.digest().toHex());
    // The document still opens and reads the same.
    expect(pageTexts(signed)).toEqual(["Page 1"]);
  });

  it.skipIf(!hasPdfsig)("is accepted by an independent checker (pdfsig), visible or not", () => {
    for (const info of [{ name: "Thandi Nkosi" }, { name: "Thandi Nkosi", page: 1, rect: [72, 600, 272, 660] as [number, number, number, number], reason: "Approved", location: "Pretoria" }]) {
      const out = pdfsig(signPrepared(prepareForSigning(makePdf(2), info), id));
      expect(out).toMatch(/Signer Certificate Common Name: Thandi Nkosi/);
      expect(out).toMatch(/Signature Validation: Signature is Valid\./);
      expect(out).toMatch(/Signed Ranges: \[0 - \d+\], \[\d+ - \d+\]/);
      expect(out).toMatch(/Total document signed/);
    }
  });

  it.skipIf(!hasPdfsig)("detects changes made after signing", () => {
    const signed = signPrepared(prepareForSigning(makePdf(1), { name: "Thandi Nkosi" }), id);
    const tampered = signed.slice();
    const at = new TextDecoder("latin1").decode(tampered).indexOf("Page 1");
    if (at >= 0) tampered[at + 5] = "9".charCodeAt(0);
    else tampered[100] ^= 1;
    expect(pdfsig(tampered)).toMatch(/Signature Validation: Digest Mismatch/);
  });

  it("refuses an expired certificate and an oversized signature", () => {
    const prepared = prepareForSigning(makePdf(1), { name: "x" });
    expect(() => signPrepared(prepared, id, new Date(Date.now() + 5 * 365 * 864e5))).toThrow(/expired/);
    expect(() => insertSignature(prepared, new Uint8Array(SIGNATURE_BYTES + 1))).toThrow(/too big/);
  });
});
