import { AWS_SERVICES } from "./aws-theme.js?v=20261028-voice-1";
import { bindVoicePractice } from "./voice-practice.js?v=20261028-voice-mp-2";

export const READ_SERVICES_KEY = "aws-warrior:v2:read-services";
export const SPOKEN_SERVICES = new Set(["s3", "ec2", "iam", "vpc", "lambda", "dynamodb"]);

export function loadReadServices(storage) {
  try {
    const saved = JSON.parse(storage.getItem(READ_SERVICES_KEY));
    return new Set(Array.isArray(saved) ? saved.filter(id => Object.hasOwn(AWS_SERVICES, id)) : []);
  } catch { return new Set(); }
}

export function bindServiceReader(game, THREE, { bindVoice = bindVoicePractice } = {}) {
  const get = id => document.getElementById(id);
  const dialog = get("service-dialog"), content = get("service-content"), mark = get("service-read");
  const voice = bindVoice(game);
  game.readServices = loadReadServices(localStorage);
  let selected, reachedEnd = false;
  const updateReadButton = () => {
    if (!dialog.open || !selected) return;
    reachedEnd ||= content.scrollTop + content.clientHeight >= content.scrollHeight - 4;
    const alreadyRead = game.readServices.has(selected);
    mark.disabled = alreadyRead || (!SPOKEN_SERVICES.has(selected) && !reachedEnd);
    mark.textContent = alreadyRead ? "Read" :
      SPOKEN_SERVICES.has(selected) ? "Voice practice to earn MP" : "Mark as read";
  };
  game.refreshServiceReader = () => {
    if (!selected) return;
    get("service-read-state").textContent = game.readServices.has(selected) ? "Read" : "New discovery";
    updateReadButton();
  };
  const showService = id => {
    const service = Object.hasOwn(AWS_SERVICES, id) ? AWS_SERVICES[id] : null;
    if (!service || !game.ready || game.traveling) return;
    game.guard.release();
    const keys = game.player.GetComponent("BasicCharacterControllerInput")._keys;
    Object.keys(keys).forEach(key => { keys[key] = false; });
    get("service-icon").src = service.icon;
    get("service-title").textContent = service.label;
    get("service-category").textContent = service.category;
    get("service-description").textContent = service.description;
    get("service-example").textContent = service.example;
    get("service-benefit").textContent = service.benefit || "";
    get("service-benefit").hidden = !service.benefit;
    get("service-benefit-heading").hidden = !service.benefit;
    get("service-source").href = service.url;
    selected = id; reachedEnd = false;
    get("service-explain").hidden = !["s3", "ec2", "iam", "vpc", "lambda", "dynamodb"].includes(id);
    mark.disabled = true;
    get("service-read-state").textContent = game.readServices.has(id) ? "Read" : "New discovery";
    game.readingService = true;
    if (!dialog.open) dialog.showModal();
    content.scrollTop = 0;
    requestAnimationFrame(updateReadButton);
  };
  content.addEventListener("scroll", updateReadButton);
  window.addEventListener("resize", updateReadButton);
  mark.onclick = () => {
    updateReadButton();
    if (mark.disabled || !selected) return;
    if (SPOKEN_SERVICES.has(selected)) {
      voice.open(selected);
      return;
    }
    game.readServices.add(selected);
    try { localStorage.setItem(READ_SERVICES_KEY, JSON.stringify([...game.readServices])); }
    catch { /* Reading remains available when browser storage is blocked. */ }
    for (const plaque of game.world.servicePlaques) {
      if (plaque.userData.awsService === selected) plaque.userData.setRead(true);
    }
    game.updateMagicUI?.();
    dialog.close();
  };
  get("mission-services").addEventListener("click", event => {
    showService(event.target.closest("[data-aws-service]")?.dataset.awsService);
  });
  get("service-close").onclick = () => dialog.close();
  get("service-explain").onclick = () => voice.open(selected);
  dialog.addEventListener("close", () => {
    game.readingService = Boolean(get("voice-desktop-dialog").open);
    game.refreshServiceReader();
    game.renderer?.domElement.focus();
  });
  const ray = new THREE.Raycaster(), point = new THREE.Vector2();
  const pick = event => {
    const bounds = game.renderer.domElement.getBoundingClientRect();
    point.set((event.clientX - bounds.left) / bounds.width * 2 - 1,
      -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    ray.setFromCamera(point, game.camera);
    return ray.intersectObjects(game.world.servicePlaques.filter(object => object.visible), false)[0]?.object;
  };
  document.addEventListener("pointermove", event => {
    const canvas = game.renderer?.domElement;
    if (!canvas || event.target !== canvas || !game.ready || game.traveling) return;
    const object = document.querySelector("dialog[open]") ? null : pick(event);
    canvas.style.cursor = object ? "pointer" : "";
    canvas.title = object ? `${AWS_SERVICES[object.userData.awsService].label}: Click to learn` : "";
  });
  let pressed;
  document.addEventListener("pointerdown", event => {
    pressed = event.target === game.renderer?.domElement && event.button === 0 ?
      { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
  });
  document.addEventListener("pointercancel", () => { pressed = null; });
  document.addEventListener("pointerup", event => {
    const start = pressed; pressed = null;
    if (!start || start.id !== event.pointerId || event.button !== 0 ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6 ||
        event.target !== game.renderer?.domElement || !game.ready || game.traveling ||
        document.querySelector("dialog[open]")) return;
    const object = pick(event);
    if (object) showService(object.userData.awsService);
  });
}
