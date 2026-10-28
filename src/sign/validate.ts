// Checks the certificate signatures in a PDF: does the signed content still
// match, is the signature itself good, and does it cover the whole file.
// (Whether the signer is somebody you trust can't be known in a browser: there is
// no list of trusted authorities here, so that is reported as a note, not a verdict.)
import forge from "node-forge";

export type SignatureStatus = "valid" | "later-changes" | "invalid";

export interface SignatureReport {
  /** 1-based, in the order they appear in the file. */
  index: number;
  signer: string;
  issuer: string;
  email?: string;
  signedAt?: Date;
  reason?: string;
  location?: string;
  /** The signed bytes still hash to what was signed. */
  digestOk: boolean;
  /** The signature on that hash is good for the signer's certificate. */
  signatureOk: boolean;
  /** The signature covers the whole file (nothing was added after it). */
  coversWholeFile: boolean;
  selfSigned: boolean;
  /** Certificate was within its dates when the file was signed. */
  certInDate: boolean;
  validFrom?: Date;
  validTo?: Date;
  hash: string;
  status: SignatureStatus;
  /** Plain-language findings. */
  notes: string[];
}

const HASHES: Record<string, () => forge.md.MessageDigest> = {
  [forge.pki.oids.sha1]: forge.md.sha1.create,
  [forge.pki.oids.sha256]: forge.md.sha256.create,
  [forge.pki.oids.sha384]: forge.md.sha384.create,
  [forge.pki.oids.sha512]: forge.md.sha512.create,
};
const HASH_NAMES: Record<string, string> = { [forge.pki.oids.sha1]: "SHA-1", [forge.pki.oids.sha256]: "SHA-256", [forge.pki.oids.sha384]: "SHA-384", [forge.pki.oids.sha512]: "SHA-512" };

const latin1 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};

const text = (s: string | undefined) => (s ? s.replace(/\\([()\\])/g, "$1").trim() : undefined);

const attr = (cert: forge.pki.Certificate["subject"], name: string) => cert.getField(name)?.value as string | undefined;

/** One signature per /ByteRange in the file. */
export function validateSignatures(bytes: Uint8Array): SignatureReport[] {
  const body = latin1(bytes);
  const reports: SignatureReport[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const [a, b, c, d] = m.slice(1, 5).map(Number);
    const report = check(bytes, body, m.index, [a, b, c, d], reports.length + 1);
    if (report) reports.push(report);
  }
  return reports;
}

function check(bytes: Uint8Array, body: string, at: number, [a, b, c, d]: number[], index: number): SignatureReport | undefined {
  const near = body.slice(Math.max(0, at - 700), at + 900);
  const reason = text(/\/Reason\s*\(((?:\\.|[^)])*)\)/.exec(near)?.[1]);
  const location = text(/\/Location\s*\(((?:\\.|[^)])*)\)/.exec(near)?.[1]);
  const base: SignatureReport = {
    index,
    signer: "Unknown",
    issuer: "Unknown",
    reason,
    location,
    digestOk: false,
    signatureOk: false,
    coversWholeFile: false,
    selfSigned: false,
    certInDate: false,
    hash: "?",
    status: "invalid",
    notes: [],
  };
  if (a !== 0 || a + b > c || c + d > bytes.length) return { ...base, notes: ["The signed range doesn't fit this file, so it can't be checked."] };
  const slot = body.slice(a + b, c); // "<hex…>"
  const hex = slot.replace(/[<>\s]/g, "");
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length < 20) return { ...base, notes: ["This signature field is empty (nobody has signed it yet)."] };
  try {
    const trimmed = hex.replace(/(?:00)+$/, "");
    const der = forge.util.hexToBytes(trimmed.length % 2 ? trimmed + "0" : trimmed);
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der, false)) as forge.pkcs7.PkcsSignedData & {
      rawCapture: { authenticatedAttributes?: forge.asn1.Asn1[]; digestAlgorithm: string; signature: string; serial: string };
      certificates: forge.pki.Certificate[];
    };
    const cap = p7.rawCapture;
    const oid = forge.asn1.derToOid(cap.digestAlgorithm);
    const make = HASHES[oid];
    if (!make) return { ...base, notes: [`Uses a hash this page can't check (${oid}).`] };
    const signer = p7.certificates.find((cert) => cert.serialNumber.replace(/^0+/, "") === forge.util.bytesToHex(cap.serial).replace(/^0+/, "")) ?? p7.certificates[0];
    if (!signer) return { ...base, notes: ["The signature carries no certificate, so it can't be checked."] };

    // 1. Do the signed bytes still hash to what was signed?
    const md = make();
    md.update(body.slice(a, a + b));
    md.update(body.slice(c, c + d));
    const digest = md.digest().bytes();
    const attrs = cap.authenticatedAttributes ?? [];
    let signedAt: Date | undefined;
    let digestOk: boolean;
    let signatureOk: boolean;
    if (attrs.length) {
      const find = (o: string) => attrs.find((x) => forge.asn1.derToOid((x.value as forge.asn1.Asn1[])[0].value as string) === o);
      const claimed = ((find(forge.pki.oids.messageDigest)?.value as forge.asn1.Asn1[] | undefined)?.[1].value as forge.asn1.Asn1[] | undefined)?.[0].value as string | undefined;
      digestOk = claimed === digest;
      const when = ((find(forge.pki.oids.signingTime)?.value as forge.asn1.Asn1[] | undefined)?.[1].value as forge.asn1.Asn1[] | undefined)?.[0];
      if (when && typeof when.value === "string") signedAt = when.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(when.value) : forge.asn1.generalizedTimeToDate(when.value);
      // 2. The signature is over the attributes, re-encoded as a SET.
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      const md2 = make();
      md2.update(forge.asn1.toDer(set).getBytes());
      try {
        signatureOk = (signer.publicKey as forge.pki.rsa.PublicKey).verify(md2.digest().bytes(), cap.signature);
      } catch {
        signatureOk = false;
      }
    } else {
      digestOk = true;
      try {
        signatureOk = (signer.publicKey as forge.pki.rsa.PublicKey).verify(digest, cap.signature);
      } catch {
        signatureOk = false;
      }
      digestOk = signatureOk;
    }

    const coversWholeFile = c + d >= bytes.length - 2;
    const selfSigned = signer.subject.hash === signer.issuer.hash;
    const when = signedAt ?? new Date();
    const certInDate = when >= signer.validity.notBefore && when <= signer.validity.notAfter;
    const notes: string[] = [];
    if (!digestOk) notes.push("The document was changed after it was signed.");
    else if (!signatureOk) notes.push("The signature itself doesn't check out, so it may be forged or damaged.");
    if (digestOk && signatureOk && !coversWholeFile) notes.push("The document was edited after this signature (the signature only covers the earlier version).");
    if (digestOk && signatureOk && coversWholeFile) notes.push("Nothing has changed since it was signed.");
    if (!certInDate) notes.push("The certificate wasn't within its dates when this was signed.");
    if (selfSigned) notes.push("The signer made their own certificate, so this proves the file is unchanged but not who they really are.");
    else notes.push("Eish PDF can't check whether the certificate authority is one you trust.");
    if (!signedAt) notes.push("No signing time is recorded.");
    return {
      ...base,
      signer: attr(signer.subject, "CN") ?? attr(signer.subject, "O") ?? "Unknown",
      issuer: attr(signer.issuer, "CN") ?? attr(signer.issuer, "O") ?? "Unknown",
      email: attr(signer.subject, "E") ?? (signer.subject.getField({ name: "emailAddress" })?.value as string | undefined),
      signedAt,
      digestOk,
      signatureOk,
      coversWholeFile,
      selfSigned,
      certInDate,
      validFrom: signer.validity.notBefore,
      validTo: signer.validity.notAfter,
      hash: HASH_NAMES[oid] ?? oid,
      status: !digestOk || !signatureOk ? "invalid" : coversWholeFile ? "valid" : "later-changes",
      notes,
    };
  } catch {
    return { ...base, notes: ["This signature couldn't be read."] };
  }
}
