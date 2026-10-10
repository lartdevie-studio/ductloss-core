/**
 * 部材・系統の id をつくる。
 *
 * ブラウザ（安全な接続）と Node 19 以降は crypto.randomUUID を使う。
 * 無い環境（古い Node・安全でない接続のブラウザ）でも止まらないよう、乱数で同じ形の id を作る。
 * id は保存データの中で部材を見分けるためだけに使い、秘密の値ではない。
 */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16)
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`
}
