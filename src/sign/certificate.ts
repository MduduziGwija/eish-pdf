// Certificate (digital) signatures: loading a .p12/.pfx, creating a test
// certificate, and producing the PKCS#7 signature for a prepared PDF.
// Uses node-forge for PKCS#12/PKCS#7 (it reads the older .p12 formats Windows
// exports) and WebCrypto for key generation. Everything stays on the device.
import forge from "node-forge";
import { insertSignature, signedBytes, type PreparedPdf } from "../core/signing";

export interface Identity {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
  chain: forge.pki.Certificate[];
  /** Common name of the certificate, shown as the signer. */
  name: string;
  email?: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  selfSigned: boolean;
}

const toBinary = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const fromBinary = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

const attr = (cert: forge.pki.Certificate, field: "subject" | "issuer", short: string) =>
  cert[field].getField(short)?.value as string | undefined;

function describe(key: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate, chain: forge.pki.Certificate[]): Identity {
  return {
    key,
    cert,
    chain,
    name: attr(cert, "subject", "CN") ?? attr(cert, "subject", "O") ?? "Unknown signer",
    email: attr(cert, "subject", "E") ?? (cert.subject.getField({ name: "emailAddress" })?.value as string | undefined),
    issuer: attr(cert, "issuer", "CN") ?? attr(cert, "issuer", "O") ?? "Unknown issuer",
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    selfSigned: cert.isIssuer(cert),
  };
}

/** Opens a .p12/.pfx file. Throws a friendly error for a wrong password or an unsupported key. */
export function loadIdentity(p12: Uint8Array, password: string): Identity {
  let parsed: forge.pkcs12.Pkcs12Pfx;
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinary(p12)), false, password);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/password|mac|invalid/i.test(msg)) throw new Error("That password doesn't open this certificate.");
    throw new Error("This doesn't look like a certificate file (.p12 or .pfx).");
  }
  const keys = [
    ...(parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(parsed.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certs = (parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  const key = keys.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new Error("This certificate file has no private key (or it's not an RSA key, which is all Eish PDF can sign with for now).");
  if (!certs.length) throw new Error("This file has a key but no certificate.");
  // The signing certificate is the one whose public key matches the private key.
  const own = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n)) ?? certs[0];
  return describe(key, own, certs.filter((c) => c !== own));
}

/**
 * Makes a self-signed test certificate and returns it with a .p12 file to
 * keep. Viewers will say the signer's identity can't be verified, because no
 * trusted authority issued it, but they'll still show the document is unchanged.
 */
export async function createTestIdentity(name: string, email: string, password: string): Promise<{ identity: Identity; p12: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const key = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(toBinary(pkcs8))) as forge.pki.rsa.PrivateKey;
  const publicKey = forge.pki.setRsaPublicKey(key.n, key.e);

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(15));
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60_000);
  cert.validity.notAfter = new Date(now.getFullYear() + 3, now.getMonth(), now.getDate());
  const subject = [{ shortName: "CN", value: name }, ...(email ? [{ name: "emailAddress", value: email }] : []), { shortName: "O", value: "Eish PDF test certificate" }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "extKeyUsage", emailProtection: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(key, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: "3des", friendlyName: name });
  return { identity: describe(key, cert, []), p12: fromBinary(forge.asn1.toDer(p12).getBytes()) };
}

/** Signs a prepared PDF (detached PKCS#7, SHA-256) and returns the finished file. */
export function signPrepared(prepared: PreparedPdf, id: Identity, when = new Date()): Uint8Array {
  if (when > id.validTo) throw new Error(`This certificate expired on ${id.validTo.toLocaleDateString("en-ZA")}.`);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(toBinary(signedBytes(prepared)));
  p7.addCertificate(id.cert);
  for (const c of id.chain) p7.addCertificate(c);
  p7.addSigner({
    key: id.key,
    certificate: id.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      // forge's types say string, but it takes a Date for signingTime.
      { type: forge.pki.oids.signingTime, value: when as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  const der = fromBinary(forge.asn1.toDer(p7.toAsn1()).getBytes());
  return insertSignature(prepared, der);
}
