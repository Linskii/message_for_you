/**
 * Node.js crypto helpers (mirrors src/crypto.ts but uses webcrypto from node:crypto)
 */
import { webcrypto } from 'node:crypto'

const subtle = webcrypto.subtle as SubtleCrypto
const ALGO = 'AES-GCM'

export interface Envelope {
  ciphertext: string
  iv: string
  templateId: string
  createdAt: string
}

export async function generateKey(): Promise<{ keyB64: string }> {
  const key = await subtle.generateKey({ name: ALGO, length: 256 }, true, ['encrypt', 'decrypt'])
  const raw = await subtle.exportKey('raw', key as CryptoKey)
  return { keyB64: bufToB64(raw as ArrayBuffer) }
}

export async function encryptMessage(plaintext: string, keyB64: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(keyB64)
  const ivBuf = webcrypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const cipherbuf = await subtle.encrypt({ name: ALGO, iv: ivBuf }, key, encoded)
  return { ciphertext: bufToB64(cipherbuf as ArrayBuffer), iv: bufToB64(ivBuf) }
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBuf(keyB64)
  return subtle.importKey('raw', raw, { name: ALGO }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>
}

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return Buffer.from(bytes).toString('base64')
}

function b64ToBuf(b64: string): ArrayBuffer {
  return Buffer.from(b64, 'base64').buffer as ArrayBuffer
}
