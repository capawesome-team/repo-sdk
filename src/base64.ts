export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function stringToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function stringToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

export function base64UrlToString(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
