import { BUILDINGS, LAKE } from "./layout.js";

export function drawMinimap(ctx, map, markers, player) {
  ctx.fillStyle = map.id === "village" ? "#294940" : "#" + map.ground.toString(16).padStart(6, "0");
  ctx.fillRect(0, 0, 200, 200);
  const scale = 91 / map.limit;
  const point = (x, z) => [100 + x * scale, 100 + z * scale];
  if (map.id === "village") {
    ctx.strokeStyle = "#a19064";
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(100, 10); ctx.lineTo(100, 190);
    ctx.moveTo(60, 100); ctx.lineTo(140, 100); ctx.stroke();
    ctx.fillStyle = "#4c8994";
    ctx.beginPath(); ctx.ellipse(...point(LAKE.x, LAKE.z), LAKE.rx * scale, LAKE.rz * scale, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#c9ac79";
    BUILDINGS.forEach(b => ctx.fillRect(...point(b.x - 8, b.z - 8), 17 * scale, 17 * scale));
    ctx.fillStyle = "#83d6cf";
    ctx.fillRect(...point(83, -96), 13, 13);
  } else {
    ctx.fillStyle = map.id === "dungeon" ? "#9aa6bd" : "#786a59";
    map.obstacles.forEach(b => ctx.fillRect(...point(b.x - b.width / 2, b.z - b.depth / 2),
      b.width * scale, b.depth * scale));
  }
  for (const gate of map.gates) {
    ctx.strokeStyle = "#" + gate.color.toString(16).padStart(6, "0");
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(...point(gate.x, gate.z), 4, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = "#ffda88";
  markers.forEach(marker => {
    if (!marker.visible) return;
    const guide = marker.userData.guide._position;
    ctx.beginPath(); ctx.arc(...point(guide.x, guide.z), 2.5, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(...point(player.x, player.z), 3.5, 0, Math.PI * 2); ctx.fill();
}
