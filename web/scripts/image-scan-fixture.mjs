// Deterministic ClamD protocol fixture for local/CI browser tests only.
// Production bootstrap always uses the configured real scanner adapter.
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

const port = Number(process.env.IMAGE_SCAN_FIXTURE_PORT ?? "3310");
const healthPort = Number(process.env.IMAGE_SCAN_FIXTURE_HEALTH_PORT ?? "3311");
const scanner = createServer(socket => {
  let received = Buffer.alloc(0);
  socket.on("data", chunk => {
    received = Buffer.concat([received, chunk]);
    if (received.length > 6 * 1024 * 1024) { socket.end("stream: size ERROR\0"); return; }
    if (received.length < 10 || received.subarray(0, 10).toString() !== "zINSTREAM\0") return;
    const parts = []; let offset = 10;
    while (offset + 4 <= received.length) {
      const length = received.readUInt32BE(offset); offset += 4;
      if (length === 0) {
        const infected = Buffer.concat(parts).includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"));
        socket.end(infected ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0"); return;
      }
      if (length > 5 * 1024 * 1024) { socket.end("stream: size ERROR\0"); return; }
      if (offset + length > received.length) return;
      parts.push(received.subarray(offset, offset + length)); offset += length;
    }
  });
});
const health = createHttpServer((_request, response) => { response.end("test scanner fixture"); });
scanner.listen(port, "127.0.0.1");
health.listen(healthPort, "127.0.0.1");
const stop = () => { scanner.close(); health.close(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
