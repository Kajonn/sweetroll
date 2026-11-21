import { readFile } from "node:fs/promises";
import { createSimulation } from "../../src/physicalDice/simulation.js";
import { test, expect, type Page } from "@playwright/test";
import type { DiceWorkerRequest, DiceWorkerResponse } from "../../src/physicalDice/worker.js";
import { fixtures } from "./fixtures.js";
import expected from "./checkpoints.json" with { type: "json" };

declare global {
  interface Window {
    stepThrow: (request: DiceWorkerRequest) => Promise<Extract<DiceWorkerResponse, { type: "frame" }>>;
  }
}
type Fixture = (typeof fixtures)[number];
async function startWorker(page: Page, fixture: Fixture) {
  await page.goto("/physics-check");
  await page.evaluate(() => {
    const worker = new Worker("/dice/v1/worker.js", { type: "module" });
    window.stepThrow = (message) =>
      new Promise((resolve, reject) => {
        worker.onmessage = ({ data }: MessageEvent<DiceWorkerResponse>) =>
          data.type === "frame" ? resolve(data) : reject(Error(data.message));
        worker.onerror = (event) => reject(Error(event.message));
        worker.postMessage(message);
      });
  });
  return page.evaluate((f) => window.stepThrow({ type: "start", ...f }), fixture);
}

// Only on failure, replay every intervening tick to distinguish an actual
// browser divergence from an intentional but unversioned change to a golden fixture.
async function diagnose(page: Page, fixture: Fixture, through: number) {
  const oracle = await createSimulation(fixture.dice, fixture.launch, async (sides) =>
    JSON.parse(await readFile(new URL(`../../public/dice/v1/d${sides}.hull.json`, import.meta.url), "utf8")),
  );
  try {
    await startWorker(page, fixture);
    for (let tick = 0; tick <= through; tick++) {
      oracle.advance(tick);
      const result = await page.evaluate(
        (tick) => window.stepThrow({ type: "advance", tick, checkpoint: true }),
        tick,
      );
      if (result.checkpoint !== (await oracle.checkpoint()))
        return `first browser divergence at tick ${tick}`;
    }
    return `browser and reference agree through tick ${through}; check the versioned golden fixture`;
  } finally {
    oracle.free();
  }
}
for (const fixture of fixtures) {
  test(`replays ${fixture.name} through the production dice worker`, async ({ page }, info) => {
    // Serve a blank same-origin page. No campaign, GPU or application shell is required.
    await page.route("**/physics-check", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Dice replay</title>" }),
    );
    let { frame } = await startWorker(page, fixture);
    const reference = expected.find((f) => f.name === fixture.name)!;
    const stride =
      info.project.name === "desktop-chromium"
        ? [2]
        : info.project.name === "phone-webkit"
          ? [1]
          : [1, 8, 39];
    for (const point of reference.snapshots) {
      if (point.tick === 30) await page.setViewportSize({ width: 840, height: 360 });
      const result = await page.evaluate(
        async ({ tick, stride, start }) => {
          let cursor = start;
          let n = 0;
          for (;;) {
            const next = Math.min(tick, cursor + stride[n++ % stride.length]!);
            const response = await window.stepThrow({
              type: "advance",
              tick: next,
              checkpoint: next === tick,
            });
            cursor = response.frame.tick;
            if (cursor >= tick || response.frame.status !== "rolling") return response;
          }
        },
        { tick: point.tick, stride, start: frame.tick },
      );
      frame = result.frame;
      if (frame.tick !== point.tick || result.checkpoint !== point.hash)
        throw Error(`${fixture.name}: ${await diagnose(page, fixture, point.tick)}`);
    }
    expect(frame.status).toBe("settled");
    expect(frame.dice.map((d) => d.value)).toEqual(reference.faces);
  });
}
