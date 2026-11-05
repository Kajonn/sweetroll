import { createConnection } from "node:net";
import type { ImageScanner } from "./image-processing.js";

/** ClamD INSTREAM on a private network; never publish this port. */
export function createClamScanner(options: { host?: string | undefined; port?: number | undefined; timeoutMs?: number | undefined } = {
  host: process.env.SWEETROLL_CLAMD_HOST,
  port: Number(process.env.SWEETROLL_CLAMD_PORT ?? "3310"),
}): ImageScanner {
  return bytes => new Promise((resolve, reject) => {
    const port = options.port ?? 3310;
    if (!options.host?.trim() || !Number.isInteger(port) || port < 1 || port > 65535) { reject(new Error("Image scanner is not configured.")); return; }
    const socket = createConnection({ host: options.host, port });
    let reply = "", finished = false;
    const timeout = setTimeout(() => finish(new Error("Image scanning timed out.")), options.timeoutMs ?? 15_000);
    function finish(error?: Error, verdict?: "clean" | "infected") {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error); else if (verdict) resolve(verdict); else reject(new Error("Incomplete image scan."));
    }
    socket.once("error", () => finish(new Error("Image scanner is unavailable.")));
    socket.on("data", chunk => {
      reply += chunk.toString("utf8");
      if (reply.length > 1024) { finish(new Error("Invalid scanner response.")); return; }
      if (!reply.endsWith("\0")) return;
      if (reply === "stream: OK\0") finish(undefined, "clean");
      else if (/^stream: [^\r\n\0]+ FOUND\0$/.test(reply)) finish(undefined, "infected");
      else finish(new Error("Image scanner rejected the request."));
    });
    socket.once("end", () => { if (!finished) finish(new Error("Incomplete image scan.")); });
    socket.once("connect", () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const chunk = bytes.subarray(offset, offset + 65536);
        const length = Buffer.alloc(4); length.writeUInt32BE(chunk.length);
        socket.write(length); socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
