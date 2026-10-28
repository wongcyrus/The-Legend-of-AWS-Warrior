import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url));
test("loading screen shows both existing logos with accessible labels and responsive sizing", () => {
  const html = read("../game-v2.html").toString();
  const loading = html.match(/<section id="loading"[\s\S]*?<\/section>/)?.[0];
  assert.ok(loading);
  for (const name of ["hkiit", "it114115"]) {
    assert.equal((loading.match(new RegExp(`src="./resources/branding/${name}-logo.png"`, "g")) ?? []).length, 1);
    assert.ok(read(`../resources/branding/${name}-logo.png`).length > 0);
  }
  assert.match(loading, /alt="HKIIT"/);
  assert.match(loading, /alt="Cloud and Data Centre Administration programme"/);
  assert.match(read("../v2/style.css").toString(), /\.loading \.loading-logos img[^}]*clamp\(80px, 18vw, 140px\)/);
});
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
