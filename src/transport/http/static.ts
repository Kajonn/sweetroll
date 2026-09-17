import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const registerStaticServing: FastifyPluginAsync<{
  distDir: string;
  enabled: boolean;
}> = async (app: FastifyInstance, opts) => {
  if (!opts.enabled) return;
  const root = path.resolve(opts.distDir);
  if (!existsSync(path.join(root, "index.html"))) return;
  await app.register(fastifyStatic, { root, prefix: "/", decorateReply: false });
  app.setNotFoundHandler((request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (url.startsWith("/api") || url.startsWith("/metrics") || url.startsWith("/health")) {
      reply.code(404).send({ code: "not_found", message: "Not found" });
      return;
    }
    reply.type("text/html").send(readFileSync(path.join(root, "index.html"), "utf8"));
  });
};
