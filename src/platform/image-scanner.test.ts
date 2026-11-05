import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createClamScanner } from "./image-scanner.js";

describe("ClamAV stream adapter", () => {
  it.each([["stream: OK\0", "clean"], ["stream: Test-Signature FOUND\0", "infected"]] as const)("accepts only a complete %s verdict", async (reply, verdict) => {
    let received = Buffer.alloc(0);
    const server = createServer(socket => {
      socket.on("data", chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.subarray(-4).equals(Buffer.alloc(4))) socket.end(reply);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing address");
      expect(await createClamScanner({ host: "127.0.0.1", port: address.port })(Buffer.from("image"))).toBe(verdict);
      expect(received.subarray(0, 10).toString()).toBe("zINSTREAM\0");
      expect(received.readUInt32BE(10)).toBe(5);
      expect(received.subarray(14, 19).toString()).toBe("image");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("fails closed without a configured scanner", async () => {
    await expect(createClamScanner({})(Buffer.from("image"))).rejects.toThrow();
  });
  it("rejects scanner protocol errors and incomplete clean responses", async () => {
    for (const reply of ["stream: OK", "INSTREAM size limit exceeded ERROR\0", "unknown\0"]) {
      const server = createServer(socket => { socket.on("data", () => socket.end(reply)); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing address");
        await expect(createClamScanner({ host: "127.0.0.1", port: address.port })(Buffer.from("image"))).rejects.toThrow();
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    }
  });
});
