const BLOCK = 512;
const encoder = new TextEncoder();

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(name: Uint8Array, size: number, mtime: number, type: string): Uint8Array {
  const block = new Uint8Array(BLOCK);
  block.set(name.subarray(0, 100), 0);
  block.set(encoder.encode(octal(0o644, 8)), 100);
  block.set(encoder.encode(octal(0, 8)), 108);
  block.set(encoder.encode(octal(0, 8)), 116);
  block.set(encoder.encode(octal(size, 12)), 124);
  block.set(encoder.encode(octal(mtime, 12)), 136);
  block.set(encoder.encode(" ".repeat(8)), 148);
  block.set(encoder.encode(type), 156);
  block.set(encoder.encode("ustar\0" + "00"), 257);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return block;
}

const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** A pax record's length counts its own digits. */
function paxRecord(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).length;
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return encoder.encode(`${length}${body}`);
}

/** One file as tar blocks. Names that are long or not ASCII, which Chinese paths always are, go in a pax header. */
export function tarEntry(path: string, content: Uint8Array, mtime: number): Uint8Array[] {
  const name = encoder.encode(path);
  const plain = name.length <= 100 && name.every(byte => byte < 0x80);
  const parts: Uint8Array[] = [];
  if (!plain) {
    const pax = paxRecord("path", path);
    parts.push(header(encoder.encode("PaxHeader"), pax.length, mtime, "x"), pax, padding(pax.length));
  }
  parts.push(header(plain ? name : encoder.encode("long-name"), content.length, mtime, "0"), content, padding(content.length));
  return parts;
}

/** Two empty blocks end an archive. */
export const tarEnd = () => new Uint8Array(BLOCK * 2);
