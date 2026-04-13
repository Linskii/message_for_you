export interface EncryptedMessage {
  /** AES-GCM ciphertext, base64 */
  ciphertext: string
  /** AES-GCM IV, base64 */
  iv: string
  /** Template skin identifier */
  templateId: string
  /** ISO timestamp of creation */
  createdAt: string
}

export interface TemplateConfig {
  id: string
  /** Path to the cover image relative to templates/{id}/ */
  image: string
  /** The rip line as an array of [x, y] points (0–1 normalised coords) */
  ripLine: [number, number][]
  /** 'straight' | 'light' | 'heavy' */
  jagStyle: 'straight' | 'light' | 'heavy'
}
