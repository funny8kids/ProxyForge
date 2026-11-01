import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────
// 信封加密：AES-256-GCM，key_version 支持主密钥轮换
// ─────────────────────────────────────────────────────────────

const KEY_VERSION = 1;
let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  // 用 HKDF 风格的定长派生：scrypt(master, fixed-salt, 32)
  cachedKey = scryptSync(config.masterKey, 'proxyforge-envelope-v1', 32);
  return cachedKey;
}

export interface Envelope {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export function seal(plaintext: string): Envelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([ct, tag]), nonce, keyVersion: KEY_VERSION };
}

export function open(envelope: Envelope): string {
  const { ciphertext, nonce } = envelope;
  const ct = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ─────────────────────────────────────────────────────────────
// 哈希 / 摘要
// ─────────────────────────────────────────────────────────────

export const sha256Hex = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('hex');

export const sha256Base64Url = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('base64url');

export const hmacHex = (key: string, input: string): string =>
  createHmac('sha256', key).update(input).digest('hex');

/** 常量时间比较，避免 token 校验被计时侧信道利用 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ─────────────────────────────────────────────────────────────
// 口令哈希：scrypt（无原生依赖）
// 说明：设计文档要求 Argon2id。Argon2 需要原生模块，本机无编译工具链，
// 故此处用 scrypt(N=16384,r=8,p=1) 作为等价强度的替代，接口保持可替换。
// ─────────────────────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, dkB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(dkB64!, 'base64');
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ─────────────────────────────────────────────────────────────
// Ed25519 订阅签名（ADR-0009 / SEC-001 §6.4）
// 选 Ed25519 而非 HMAC：非对称，客户端只持公钥即可验签，
// 泄露公钥不会导致可伪造；且天然支持密钥轮换与多客户端分发。
// ─────────────────────────────────────────────────────────────

export interface SigningKeyPair {
  /** base64url(raw 32 bytes) —— 可直接进 signing_keys.public_key */
  publicKeyRaw: string;
  /** base64 PKCS#8 DER —— 只写入 secrets.ciphertext，永不返回 API */
  privateKeyPkcs8: string;
  keyId: string;
}

export function generateSigningKeyPair(keyId: string): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = spki.subarray(spki.length - 32);
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    publicKeyRaw: raw.toString('base64url'),
    privateKeyPkcs8: pkcs8.toString('base64'),
    keyId,
  };
}

function importPrivate(pkcs8B64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(pkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
}

function importPublicRaw(rawB64Url: string): KeyObject {
  const raw = Buffer.from(rawB64Url, 'base64url');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** 签名输入是 JCS 规范化后的 UTF-8 字节 */
export function ed25519Sign(canonicalJson: string, privateKeyPkcs8: string): string {
  const sig = nodeSign(null, Buffer.from(canonicalJson, 'utf8'), importPrivate(privateKeyPkcs8));
  return sig.toString('base64url');
}

export function ed25519Verify(
  canonicalJson: string,
  signatureB64Url: string,
  publicKeyRaw: string,
): boolean {
  try {
    return nodeVerify(
      null,
      Buffer.from(canonicalJson, 'utf8'),
      importPublicRaw(publicKeyRaw),
      Buffer.from(signatureB64Url, 'base64url'),
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 脱敏
// ─────────────────────────────────────────────────────────────

/** sk-abcdef...wxyz -> sk-****wxyz（API 文档 §4.7 要求） */
export function maskSecret(plain: string): string {
  if (plain.length <= 8) return '****';
  const head = plain.slice(0, 3);
  const tail = plain.slice(-4);
  return `${head}****${tail}`;
}
