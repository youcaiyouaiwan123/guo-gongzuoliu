const PBKDF2_PREFIX = "pbkdf2-sha256";
const PBKDF2_ITERATIONS = 600_000;

export type PasswordRecord = {
  passwordHash: string;
  passwordSalt: string;
};

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function equalsHex(left: string, right: string) {
  const leftBytes = fromHex(left);
  const rightBytes = fromHex(right);
  if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

async function legacyHash(password: string, salt: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${password}`));
  return toHex(new Uint8Array(digest));
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = Uint8Array.from(salt).buffer;
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

export async function createPasswordRecord(password: string): Promise<PasswordRecord> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const passwordSalt = toHex(saltBytes);
  const hash = await derive(password, saltBytes, PBKDF2_ITERATIONS);
  return { passwordSalt, passwordHash: `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${hash}` };
}

export async function verifyPassword(password: string, record: PasswordRecord) {
  const [algorithm, iterationText, storedHash] = record.passwordHash.split("$");
  if (algorithm !== PBKDF2_PREFIX) {
    return { valid: equalsHex(await legacyHash(password, record.passwordSalt), record.passwordHash), needsUpgrade: true };
  }
  const iterations = Number(iterationText);
  const salt = fromHex(record.passwordSalt);
  if (!salt || !Number.isSafeInteger(iterations) || iterations < 1 || !storedHash) return { valid: false, needsUpgrade: false };
  const valid = equalsHex(await derive(password, salt, iterations), storedHash);
  return { valid, needsUpgrade: valid && iterations < PBKDF2_ITERATIONS };
}
