/**
 * Digital IDs and CMS signatures for PDF signing. A .pfx/.p12 file is opened
 * with node-forge (password-based decryption and MAC check), and the private
 * key goes straight into Web Crypto as a non-extractable key; signing and
 * verifying use Web Crypto, so RSA and EC (P-256/384/521) keys both work.
 * Nothing is stored: the key lives only as long as the signing session.
 */
import forge from 'node-forge';
import { bytesOf, concat, ctx, equalBytes, int, nul, octets, oid, oidOf, parse, rawOf, seq, setOf, TAG, textOf, timeOf, toHex, type Node } from './der';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  rsa: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  sha1Rsa: '1.2.840.113549.1.1.5',
  sha256Rsa: '1.2.840.113549.1.1.11',
  sha384Rsa: '1.2.840.113549.1.1.12',
  sha512Rsa: '1.2.840.113549.1.1.13',
  ec: '1.2.840.10045.2.1',
  ecdsaSha1: '1.2.840.10045.4.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  ecdsaSha512: '1.2.840.10045.4.3.4',
  p256: '1.2.840.10045.3.1.7',
  p384: '1.3.132.0.34',
  p521: '1.3.132.0.35',
  basicConstraints: '2.5.29.19',
};

const HASHES: Record<string, string> = {
  [OID.sha1]: 'SHA-1',
  [OID.sha256]: 'SHA-256',
  [OID.sha384]: 'SHA-384',
  [OID.sha512]: 'SHA-512',
  [OID.sha1Rsa]: 'SHA-1',
  [OID.sha256Rsa]: 'SHA-256',
  [OID.sha384Rsa]: 'SHA-384',
  [OID.sha512Rsa]: 'SHA-512',
  [OID.ecdsaSha1]: 'SHA-1',
  [OID.ecdsaSha256]: 'SHA-256',
  [OID.ecdsaSha384]: 'SHA-384',
  [OID.ecdsaSha512]: 'SHA-512',
};

const CURVES: Record<string, string> = { [OID.p256]: 'P-256', [OID.p384]: 'P-384', [OID.p521]: 'P-521' };

/* ------------------------------------------------------------------ */
/* Certificates                                                         */
/* ------------------------------------------------------------------ */

const NAME_KEYS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '1.2.840.113549.1.9.1': 'E',
};

export interface CertInfo {
  der: Uint8Array;
  /** Common name, or the most descriptive part of the subject. */
  name: string;
  subject: Record<string, string>;
  issuerName: string;
  issuer: Record<string, string>;
  /** DER of the issuer Name and serial INTEGER, for IssuerAndSerialNumber. */
  issuerDer: Uint8Array;
  serialDer: Uint8Array;
  serialHex: string;
  notBefore: Date;
  notAfter: Date;
  selfSigned: boolean;
  isCA: boolean;
  /** SubjectPublicKeyInfo DER, for Web Crypto. */
  spki: Uint8Array;
  keyType: 'RSA' | 'EC' | 'other';
  curve?: string;
}

function readName(n: Node) {
  const out: Record<string, string> = {};
  for (const rdn of n.children) {
    for (const atv of rdn.children) {
      const key = NAME_KEYS[oidOf(atv.children[0])];
      if (key && !out[key]) out[key] = textOf(atv.children[1]);
    }
  }
  return out;
}

const displayName = (n: Record<string, string>) => n.CN || n.O || n.E || n.OU || 'Unknown';

export function parseCert(der: Uint8Array): CertInfo {
  const cert = parse(der);
  const tbs = cert.children[0];
  let i = 0;
  if (tbs.children[0].tag === 0xa0) i++; // version
  const serial = tbs.children[i];
  const issuerN = tbs.children[i + 2];
  const validity = tbs.children[i + 3];
  const subjectN = tbs.children[i + 4];
  const spkiN = tbs.children[i + 5];
  const subject = readName(subjectN);
  const issuer = readName(issuerN);
  const algOid = oidOf(spkiN.children[0].children[0]);
  const param = spkiN.children[0].children[1];
  let isCA = false;
  const exts = tbs.children.find((c) => c.tag === 0xa3);
  for (const ext of exts?.children[0]?.children ?? []) {
    if (oidOf(ext.children[0]) !== OID.basicConstraints) continue;
    const value = ext.children[ext.children.length - 1];
    const bc = parse(bytesOf(value));
    isCA = bc.children[0]?.tag === TAG.BOOLEAN && bytesOf(bc.children[0])[0] !== 0;
  }
  return {
    der: rawOf(cert).slice(),
    name: displayName(subject),
    subject,
    issuerName: displayName(issuer),
    issuer,
    issuerDer: rawOf(issuerN).slice(),
    serialDer: rawOf(serial).slice(),
    serialHex: toHex(bytesOf(serial)),
    notBefore: timeOf(validity.children[0]),
    notAfter: timeOf(validity.children[1]),
    selfSigned: equalBytes(rawOf(issuerN), rawOf(subjectN)),
    isCA,
    spki: rawOf(spkiN).slice(),
    keyType: algOid === OID.rsa || algOid === OID.rsaPss ? 'RSA' : algOid === OID.ec ? 'EC' : 'other',
    curve: algOid === OID.ec && param?.tag === TAG.OID ? CURVES[oidOf(param)] : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Digital IDs (.pfx / .p12)                                            */
/* ------------------------------------------------------------------ */

export interface Identity {
  cert: CertInfo;
  /** Signer first, then any other certificates in the file. */
  chain: CertInfo[];
  key: CryptoKey;
}

export class WrongPassword extends Error {}

const toBinary = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const fromBinary = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const derOf = (a: forge.asn1.Asn1) => fromBinary(forge.asn1.toDer(a).getBytes());

/** Opens a .pfx/.p12 file. The password is used once here and not kept. */
export async function openIdentity(file: Uint8Array, password: string): Promise<Identity> {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinary(file)), false, password);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/MAC could not be verified|Invalid password|wrong password|decrypt/i.test(msg)) throw new WrongPassword('Wrong password');
    throw new Error("This doesn't look like a .pfx or .p12 digital ID");
  }
  const bagsOf = (type: string) => p12.getBags({ bagType: type })[type] ?? [];
  const keyBags = [...bagsOf(forge.pki.oids.pkcs8ShroudedKeyBag), ...bagsOf(forge.pki.oids.keyBag)];
  const certBags = bagsOf(forge.pki.oids.certBag);
  const keyBag = keyBags[0];
  if (!keyBag) throw new Error('This digital ID has no private key');
  if (!certBags.length) throw new Error('This digital ID has no certificate');

  const certs = certBags.map((b) => ({
    info: parseCert(b.cert ? derOf(forge.pki.certificateToAsn1(b.cert)) : derOf(b.asn1 as forge.asn1.Asn1)),
    keyId: b.attributes?.localKeyId?.[0] as string | undefined,
  }));
  const keyId = keyBag.attributes?.localKeyId?.[0] as string | undefined;
  const signer = certs.find((c) => keyId && c.keyId === keyId) ?? certs.find((c) => !c.info.isCA) ?? certs[0];

  const pkcs8 = keyBag.key
    ? derOf(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keyBag.key as forge.pki.rsa.PrivateKey)))
    : derOf(keyBag.asn1 as forge.asn1.Asn1);
  const info = signer.info;
  let key: CryptoKey;
  if (info.keyType === 'RSA') {
    key = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } else if (info.keyType === 'EC' && info.curve) {
    key = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'ECDSA', namedCurve: info.curve }, false, ['sign']);
  } else {
    throw new Error('Only RSA and EC (P-256, P-384, P-521) digital IDs are supported');
  }
  pkcs8.fill(0);
  return { cert: info, chain: [info, ...certs.filter((c) => c !== signer).map((c) => c.info)], key };
}

/* ------------------------------------------------------------------ */
/* Signing                                                              */
/* ------------------------------------------------------------------ */

const sha = async (alg: string, data: Uint8Array) => new Uint8Array(await crypto.subtle.digest(alg, data as BufferSource));

/** Web Crypto's ECDSA signature (r || s) as the DER SEQUENCE CMS expects. */
function ecdsaToDer(raw: Uint8Array) {
  const half = raw.length / 2;
  return seq(int(raw.subarray(0, half)), int(raw.subarray(half)));
}

/** DER ECDSA signature to r || s, each padded to the curve size. */
function ecdsaFromDer(der: Uint8Array, size: number) {
  const n = parse(der);
  const part = (x: Node) => {
    let b = bytesOf(x);
    while (b.length > size && b[0] === 0) b = b.subarray(1);
    const out = new Uint8Array(size);
    out.set(b, size - b.length);
    return out;
  };
  return concat([part(n.children[0]), part(n.children[1])]);
}

const attribute = (type: string, value: Uint8Array) => seq(oid(type), setOf([value]));

/**
 * A detached CMS SignedData over `digest` (SHA-256 of the signed bytes), with
 * the signed attributes PAdES baseline B-B asks for: content type, message
 * digest and the signing certificate (ESS signing-certificate-v2). The time
 * of signing goes in the PDF signature dictionary instead.
 */
export async function signDigest(id: Identity, digest: Uint8Array): Promise<Uint8Array> {
  const cert = id.cert;
  const essCertId = seq(octets(await sha('SHA-256', cert.der)), seq(seq(ctx(4, cert.issuerDer)), cert.serialDer));
  const attrs = [attribute(OID.contentType, oid(OID.data)), attribute(OID.messageDigest, octets(digest)), attribute(OID.signingCertificateV2, seq(seq(essCertId)))];
  const signedAttrs = setOf(attrs);
  const ec = cert.keyType === 'EC';
  const raw = new Uint8Array(
    await crypto.subtle.sign(ec ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }, id.key, signedAttrs as BufferSource),
  );
  const signature = ec ? ecdsaToDer(raw) : raw;
  const sha256Alg = seq(oid(OID.sha256));
  const signerInfo = seq(
    int(1),
    seq(cert.issuerDer, cert.serialDer),
    sha256Alg,
    // The same SET, re-tagged [0] IMPLICIT.
    concat([new Uint8Array([0xa0]), signedAttrs.subarray(1)]),
    ec ? seq(oid(OID.ecdsaSha256)) : seq(oid(OID.sha256Rsa), nul()),
    octets(signature),
  );
  const signedData = seq(int(1), setOf([sha256Alg]), seq(oid(OID.data)), ctx(0, id.chain.map((c) => c.der)), setOf([signerInfo]));
  return seq(oid(OID.signedData), ctx(0, signedData));
}

/* ------------------------------------------------------------------ */
/* Verifying                                                            */
/* ------------------------------------------------------------------ */

export interface CmsCheck {
  /** The signed bytes hash to the digest in the signature. */
  intact: boolean;
  /** The signature over that digest checks out against the signer's certificate. */
  signatureOk: boolean;
  signer: CertInfo | null;
  /** From the signed attributes, if the signer put one there. */
  signingTime?: Date;
  timestamped: boolean;
  /** Why it couldn't be checked, if it couldn't. */
  problem?: string;
}

async function verifySignature(cert: CertInfo, sigAlg: string, hashName: string, data: Uint8Array, signature: Uint8Array) {
  const spkiAlg = oidOf(parse(cert.spki).children[0].children[0]);
  if (spkiAlg === OID.rsa && sigAlg !== OID.rsaPss) {
    const key = await crypto.subtle.importKey('spki', cert.spki as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: hashName }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, data as BufferSource);
  }
  if (spkiAlg === OID.rsa || spkiAlg === OID.rsaPss) {
    const key = await crypto.subtle.importKey('spki', cert.spki as BufferSource, { name: 'RSA-PSS', hash: hashName }, false, ['verify']);
    const saltLength = { 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 }[hashName] ?? 32;
    return crypto.subtle.verify({ name: 'RSA-PSS', saltLength }, key, signature as BufferSource, data as BufferSource);
  }
  if (spkiAlg === OID.ec && cert.curve) {
    const key = await crypto.subtle.importKey('spki', cert.spki as BufferSource, { name: 'ECDSA', namedCurve: cert.curve }, false, ['verify']);
    const size = { 'P-256': 32, 'P-384': 48, 'P-521': 66 }[cert.curve]!;
    return crypto.subtle.verify({ name: 'ECDSA', hash: hashName }, key, ecdsaFromDer(signature, size) as BufferSource, data as BufferSource);
  }
  throw new Error('unsupported key type');
}

/** Checks a detached CMS signature (adbe.pkcs7.detached / ETSI.CAdES.detached) over `parts`. */
export async function verifyCms(pkcs7: Uint8Array, parts: Uint8Array[]): Promise<CmsCheck> {
  const result: CmsCheck = { intact: false, signatureOk: false, signer: null, timestamped: false };
  try {
    const info = parse(pkcs7);
    if (oidOf(info.children[0]) !== OID.signedData) return { ...result, problem: 'not a CMS signature' };
    const sd = info.children[1].children[0];
    const certsNode = sd.children.find((c) => c.tag === 0xa0);
    const certs = (certsNode?.children ?? []).filter((c) => c.tag === TAG.SEQUENCE).map((c) => parseCert(rawOf(c).slice()));
    const signerInfo = sd.children[sd.children.length - 1].children[0];
    const [, sid, digestAlgN, ...rest] = signerInfo.children;
    const signedAttrsN = rest[0]?.tag === 0xa0 ? rest.shift() : undefined;
    const sigAlgN = rest[0];
    const sigN = rest[1];
    const unsigned = rest[2];
    result.timestamped = !!unsigned?.children.some((a) => oidOf(a.children[0]) === OID.timeStampToken);

    // The signer: by issuer and serial number, or by subject key identifier.
    let signer: CertInfo | undefined;
    if (sid.tag === TAG.SEQUENCE) {
      const issuer = rawOf(sid.children[0]);
      const serial = rawOf(sid.children[1]);
      signer = certs.find((c) => equalBytes(c.issuerDer, issuer) && equalBytes(c.serialDer, serial));
    }
    signer ??= certs.find((c) => !c.isCA) ?? certs[0];
    result.signer = signer ?? null;

    const hashName = HASHES[oidOf(digestAlgN.children[0])];
    if (!hashName) return { ...result, problem: 'unsupported digest algorithm' };
    const contentDigest = await sha(hashName, concat(parts));
    const signature = bytesOf(sigN);
    const sigAlg = oidOf(sigAlgN.children[0]);
    let signedData: Uint8Array;
    if (signedAttrsN) {
      let md: Uint8Array | null = null;
      for (const a of signedAttrsN.children) {
        const type = oidOf(a.children[0]);
        if (type === OID.messageDigest) md = bytesOf(a.children[1].children[0]);
        if (type === OID.signingTime) result.signingTime = timeOf(a.children[1].children[0]);
      }
      result.intact = !!md && equalBytes(md, contentDigest);
      // What was signed is the attribute set with its universal SET tag.
      const raw = rawOf(signedAttrsN);
      signedData = concat([new Uint8Array([TAG.SET]), raw.subarray(1)]);
    } else {
      result.intact = true; // checked by the signature itself below
      signedData = concat(parts);
    }
    if (!signer) return { ...result, problem: 'the signer certificate is missing' };
    const sigHash = HASHES[sigAlg] ?? hashName;
    result.signatureOk = await verifySignature(signer, sigAlg, sigHash, signedData, signature);
    if (!signedAttrsN) result.intact = result.signatureOk;
    return result;
  } catch (e) {
    console.warn('Signature could not be read', e);
    return { ...result, problem: 'the signature could not be read' };
  }
}

