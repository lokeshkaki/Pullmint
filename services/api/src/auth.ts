import crypto from 'crypto';

export function timingSafeTokenCompare(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    const dummyBuffer = Buffer.alloc(providedBuffer.length);
    crypto.timingSafeEqual(providedBuffer, dummyBuffer);
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
