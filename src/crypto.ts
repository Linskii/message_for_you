import type { EncryptedMessage } from './types'

const ALGO = 'AES-GCM'
const KEY_LENGTH = 256

/** Generate a new AES-GCM key and return it as a base64 string */
export async function generateKey(): Promise<{ key: CryptoKey; keyB64: string }> {
  const key = await crypto.subtle.generateKey({ name: ALGO, length: KEY_LENGTH }, true, ['encrypt', 'decrypt'])
  const raw = await crypto.subtle.exportKey('raw', key)
  return { key, keyB64: bufToB64(raw) }
}

/** Encrypt a plaintext string; returns the envelope fields */
export async function encryptMessage(
  plaintext: string,
  keyB64: string,
): Promise<Pick<EncryptedMessage, 'ciphertext' | 'iv'>> {
  const key = await importKey(keyB64)
  const ivArr = new Uint8Array(12)
  crypto.getRandomValues(ivArr)
  const encoded = new TextEncoder().encode(plaintext)
  // Pass .buffer (ArrayBuffer) to satisfy strict DOM typings
  const cipherbuf = await crypto.subtle.encrypt({ name: ALGO, iv: ivArr.buffer as ArrayBuffer }, key, encoded)
  return {
    ciphertext: bufToB64(cipherbuf),
    iv: bufToB64(ivArr),
  }
}

/** Decrypt an EncryptedMessage envelope using a base64 key string */
export async function decryptMessage(envelope: EncryptedMessage, keyB64: string): Promise<string> {
  const key = await importKey(keyB64)
  const ciphertext = b64ToBuf(envelope.ciphertext)
  const iv = b64ToBuf(envelope.iv)
  const plainbuf = await crypto.subtle.decrypt({ name: ALGO, iv: iv.buffer as ArrayBuffer }, key, ciphertext.buffer as ArrayBuffer)
  return new TextDecoder().decode(plainbuf)
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBuf(keyB64)
  return crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, { name: ALGO }, false, ['encrypt', 'decrypt'])
}

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin)
}

function b64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
