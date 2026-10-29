/**
 * Building blocks for the hand-written decoders each provider runs on its response bodies. A
 * decoder defines what a valid entity of its raw type is for this SDK: it checks every field the
 * SDK reads anywhere without a fallback and leaves the rest to the raw type, so an answer from the
 * wrong server or endpoint fails with a precise `invalid_response` while a real provider's optional
 * fields never do.
 */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

export function expectArray(value: unknown, what: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new DecodeError(`expected an array of ${what}`);
}

export function expectBoolean(value: unknown, what: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new DecodeError(`expected a boolean for ${what}`);
}

export function expectNumber(value: unknown, what: string): number {
  if (typeof value === 'number') return value;
  throw new DecodeError(`expected a number for ${what}`);
}

export function expectRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new DecodeError(`expected an object for ${what}`);
}

export function expectString(value: unknown, what: string): string {
  if (typeof value === 'string') return value;
  throw new DecodeError(`expected a string for ${what}`);
}
