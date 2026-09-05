import { createHmac } from "node:crypto";

import type { Rng } from "../rules/evaluate.js";

export function createDeterministicRng(secret: string, executionId: string): Rng {
  let block: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let offset = 0;
  let counter = 0;

  return () => {
    if (offset === block.length) {
      block = createHmac("sha256", secret).update(`${executionId}:${counter}`).digest();
      counter += 1;
      offset = 0;
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value / 2 ** 32;
  };
}
