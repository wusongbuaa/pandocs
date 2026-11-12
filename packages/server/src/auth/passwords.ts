import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const LENGTH = 32;

export const MIN_PASSWORD_LENGTH = 8;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password.normalize("NFKC"), salt, LENGTH, { N: n, r, p, maxmem: 256 * n * r }, (error, key) => (error ? reject(error) : resolve(key)));
});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Checked even when the account does not exist, so response times do not reveal which addresses have one. */
export const DUMMY_PASSWORD_HASH = await hashPassword(randomBytes(16).toString("hex"));
