export function bytesFromHex(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error('Program must be non-empty 0x-prefixed even-length hex data');
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return bytes;
}

export function hexFromBytes(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
