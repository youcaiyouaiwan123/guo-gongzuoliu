// 平台凭证加密统一入口。
// 历史问题：app/api 下 11 个 route.ts 各自实现了一份 base64 + SHA-256 + AES-GCM，
// IV 长度在不同位置被硬编码为 12 但缺失 importKey 处的 type guard，错误的 IV 长度会让旧库
// 写出的密文在新代码中解密失败。本模块把算法、IV 长度、密钥派生收敛到一处，作为唯一事实源。
import { env } from "cloudflare:workers";

type CryptoRuntime = { PLATFORM_CREDENTIALS_KEY?: string };
const cryptoRuntime = env as unknown as CryptoRuntime;

// AES-GCM 规范要求 96 bit（12 字节）IV。所有写入路径必须使用此长度；
// 历史数据库的密文若 IV 长度与此不一致，加解密会抛错并以 null 形式返回，让调用方决定回退策略。
const IV_BYTES = 12;

export function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(usage: KeyUsage[]): Promise<CryptoKey> {
  const secret = cryptoRuntime.PLATFORM_CREDENTIALS_KEY;
  if (!secret) throw new Error("平台凭证加密密钥尚未配置");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, usage);
}

/**
 * 加密一段明文，输出 `b64(iv).b64(data)` 字符串。
 * 写入路径使用：失败时抛出（无密钥即无法写入）。
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await deriveKey(["encrypt"]),
    new TextEncoder().encode(plaintext),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(data))}`;
}

/**
 * 解密一段密文，输出明文。失败时返回 null 而非抛出，便于读路径优雅降级。
 */
export async function decryptSecret(payload: string): Promise<string | null> {
  if (!cryptoRuntime.PLATFORM_CREDENTIALS_KEY) return null;
  const [iv, data] = payload.split(".");
  if (!iv || !data) return null;
  try {
    const result = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(iv) },
      await deriveKey(["decrypt"]),
      base64ToBytes(data),
    );
    return new TextDecoder().decode(result);
  } catch {
    return null;
  }
}

export async function encryptJson<T>(value: T): Promise<string> {
  return encryptSecret(JSON.stringify(value));
}

export async function decryptJson<T>(payload: string): Promise<T | null> {
  const text = await decryptSecret(payload);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
