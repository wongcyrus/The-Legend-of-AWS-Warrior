import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url));
test("app and game use the same HKIIT favicon, not React defaults", () => {
  const app = read("../../web-app/public/favicon.ico"), game = read("../favicon.ico");
  assert.deepEqual(app, game);
  assert.equal(app.readUInt16LE(0), 0);
  assert.equal(app.readUInt16LE(2), 1);
  assert.equal(app.readUInt16LE(4), 7);
  for (const name of ["game", "game-v2", "voice-practice", "voice-marks"]) {
    assert.match(read(`../${name}.html`).toString(), /rel="icon"[^>]+favicon\.ico\?v=hkiit-1/);
  }
  const manifest = JSON.parse(read("../../web-app/public/manifest.json"));
  assert.equal(manifest.name, "HKIIT AWS Warrior");
  assert.ok(manifest.icons.every(icon => icon.src.endsWith("?v=hkiit-1")));
  for (const size of [192, 512]) {
    const png = read(`../../web-app/public/logo${size}.png`);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  assert.doesNotMatch(read("../../web-app/public/index.html").toString(), /Web site created using create-react-app/);
});
