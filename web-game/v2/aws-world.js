import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { AWS_SERVICES, AWS_LANDMARKS, BUILDING_SERVICES, CLOUD_REGIONS } from "./aws-theme.js?v=20261028-voice-1";

const images = new Map();
const pendingImages = new Map();
const imageListeners = new Map();

function loadServiceImage(id) {
  if (!pendingImages.has(id)) pendingImages.set(id, new Promise(resolve => {
    const image = new Image();
    const finish = () => { clearTimeout(timeout); resolve(); };
    const timeout = setTimeout(finish, 5000);
    image.onload = () => {
      images.set(id, image);
      imageListeners.get(id)?.forEach(draw => draw(image));
      imageListeners.delete(id);
      finish();
    };
    image.onerror = finish;
    image.src = AWS_SERVICES[id].icon;
  }));
  return pendingImages.get(id);
}

export async function loadServiceImages(ids = [
  ...BUILDING_SERVICES, ...Object.values(CLOUD_REGIONS).map(region => region.service),
  ...AWS_LANDMARKS.village.map(point => point.service),
]) {
  await Promise.all([...new Set(ids)].map(loadServiceImage));
}

export function servicePlaque(world, parent, id, { x, y, z, width = 8, rotation = 0, subtitle } = {}) {
  const service = AWS_SERVICES[id];
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 192;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#182635";
  ctx.fillRect(0, 0, 512, 192);
  ctx.strokeStyle = "#ff9900";
  ctx.lineWidth = 6;
  ctx.strokeRect(4, 4, 504, 184);
  const image = images.get(id);
  if (image) ctx.drawImage(image, 24, 32, 128, 128);
  else {
    ctx.fillStyle = "#ff9900";
    ctx.font = "bold 30px sans-serif";
    ctx.fillText("AWS", 42, 105);
  }
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 29px sans-serif";
  ctx.fillText(service.label, 176, 82, 316);
  ctx.fillStyle = "#d1dae4";
  ctx.font = "21px sans-serif";
  ctx.fillText(subtitle || service.category, 176, 122, 316);
  const texture = new THREE.CanvasTexture(canvas);
  texture.encoding = THREE.sRGBEncoding;
  if (!image) {
    const draw = loaded => {
      ctx.fillStyle = "#182635";
      ctx.fillRect(18, 24, 140, 144);
      ctx.drawImage(loaded, 24, 32, 128, 128);
      texture.needsUpdate = true;
    };
    if (!imageListeners.has(id)) imageListeners.set(id, new Set());
    imageListeners.get(id).add(draw);
    texture.addEventListener?.("dispose", () => {
      imageListeners.get(id)?.delete(draw);
      if (!imageListeners.get(id)?.size) imageListeners.delete(id);
    });
    loadServiceImage(id);
  }
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  const plaque = world.mesh(new THREE.PlaneGeometry(width, width * 192 / 512), material, x, y, z, parent);
  plaque.rotation.y = rotation;
  plaque.userData.awsService = id;
  plaque.userData.awsWidth = width;
  plaque.userData.setRead = read => {
    ctx.fillStyle = "#182635";
    ctx.fillRect(170, 140, 324, 36);
    ctx.fillStyle = read ? "#9ed6b5" : "#ffb454";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText(read ? "READ - Click to revisit" : "NEW - Click to learn", 176, 165, 316);
    plaque.userData.serviceRead = read;
    texture.needsUpdate = true;
  };
  plaque.userData.setRead(Boolean(world.readServices?.has(id)));
  world.servicePlaques?.push(plaque);
  return plaque;
}

export function buildServiceLandmarks(world) {
  const post = new THREE.BoxGeometry(0.3, 5, 0.3);
  const wood = world.material(0x5a4031);
  for (const landmark of AWS_LANDMARKS[world.map.id]) {
    const { service, x, z, label } = landmark;
    world.mesh(post, wood, x, 2.5, z - 0.08);
    const sign = servicePlaque(world, world.scene, service,
      { x, y: 4.6, z, width: 6, subtitle: label });
    sign.userData.awsLandmark = service;
  }
}
