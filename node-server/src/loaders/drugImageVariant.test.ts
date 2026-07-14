import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { renderDrugWebImage } from "./drugImageVariant.js";

test("drug web image preserves source bytes and limits the longest edge", async () => {
  const source = await sharp({
    create: { width: 2200, height: 1100, channels: 3, background: "#f3f4f6" },
  }).png().toBuffer();
  const before = Buffer.from(source);

  const rendered = await renderDrugWebImage(source);
  const metadata = await sharp(rendered.data).metadata();

  assert.deepEqual(source, before);
  assert.equal(metadata.format, "webp");
  assert.equal(rendered.width, 1600);
  assert.equal(rendered.height, 800);
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 800);
});

test("drug web image rejects invalid image bytes", async () => {
  await assert.rejects(() => renderDrugWebImage(Buffer.from("not an image")));
});
