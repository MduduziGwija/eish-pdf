import { beforeAll, describe, expect, it } from "vitest";
import { prepareForSigning } from "../src/core/signing";
import { createTestIdentity, signPrepared, type Identity } from "../src/sign/certificate";
import { validateSignatures } from "../src/sign/validate";
import { makePdf } from "./fixtures";

let id: Identity;
beforeAll(async () => {
  ({ identity: id } = await createTestIdentity("Thandi Nkosi", "thandi@example.co.za", "pw"));
}, 30_000);

const signed = () => signPrepared(prepareForSigning(makePdf(1), { name: "Thandi Nkosi", reason: "Approved", location: "Pretoria" }), id);

describe("signature validation", () => {
  it("accepts an untouched signed file and reads who signed", () => {
    const [r] = validateSignatures(signed());
    expect(r.status).toBe("valid");
    expect(r.digestOk && r.signatureOk && r.coversWholeFile).toBe(true);
    expect(r.signer).toBe("Thandi Nkosi");
    expect(r.selfSigned).toBe(true);
    expect(r.reason).toBe("Approved");
    expect(r.location).toBe("Pretoria");
    expect(r.signedAt).toBeInstanceOf(Date);
    expect(r.certInDate).toBe(true);
  });
  it("spots a changed document", () => {
    const bytes = signed().slice();
    const at = new TextDecoder("latin1").decode(bytes).indexOf("Page 1");
    bytes[at >= 0 ? at + 5 : 100] ^= 1;
    const [r] = validateSignatures(bytes);
    expect(r.status).toBe("invalid");
    expect(r.digestOk).toBe(false);
  });
  it("spots a forged signature value", () => {
    const bytes = signed().slice();
    const text = new TextDecoder("latin1").decode(bytes);
    const start = text.indexOf("/Contents <") + 11;
    // Flip a byte near the end of the real signature bytes (the RSA value).
    let end = start;
    while (text.slice(end, end + 8) !== "00000000") end++;
    bytes[end - 6] = bytes[end - 6] === 0x41 ? 0x42 : 0x41;
    const [r] = validateSignatures(bytes);
    expect(r.status).toBe("invalid");
  });
  it("notices edits added after signing", () => {
    const base = signed();
    const extra = new TextEncoder().encode("\n% added later\n");
    const bytes = new Uint8Array(base.length + extra.length);
    bytes.set(base);
    bytes.set(extra, base.length);
    const [r] = validateSignatures(bytes);
    expect(r.digestOk && r.signatureOk).toBe(true);
    expect(r.coversWholeFile).toBe(false);
    expect(r.status).toBe("later-changes");
  });
  it("reports no signatures for a plain PDF", () => {
    expect(validateSignatures(makePdf(1))).toEqual([]);
  });
});
