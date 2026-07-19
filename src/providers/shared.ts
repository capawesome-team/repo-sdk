export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function clampPerPage(limit: number | undefined, max = 100): number | undefined {
  if (limit === undefined) return undefined;
  return Math.min(Math.max(1, Math.trunc(limit)), max);
}

export function parseLinkNext(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match && match[2] === 'next') return match[1];
  }
  return undefined;
}

/** Percent-encodes a ref path while keeping its `/` separators intact. */
export function encodeRefPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

export function commitWebUrlBuilder(pathSegment: string) {
  return function commitWebUrl(repoWebUrl: string, sha: string): string {
    return `${repoWebUrl.replace(/\/+$/, '')}/${pathSegment}/${sha}`;
  };
}

export function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (extended?.[1]) {
    return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain?.[1]?.trim();
}
