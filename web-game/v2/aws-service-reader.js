import { AWS_SERVICES } from "./aws-theme.js?v=20261028-voice-1";
import { bindVoicePractice } from "./voice-practice.js?v=20261031-voice-counts-1";

export const READ_SERVICES_KEY = "aws-warrior:v2:read-services";

export function loadReadServices(storage) {
  try {
    const saved = JSON.parse(storage.getItem(READ_SERVICES_KEY));
    return new Set(Array.isArray(saved) ? saved.filter(id => Object.hasOwn(AWS_SERVICES, id)) : []);
  } catch { return new Set(); }
}

export function bindServiceReader(game, THREE, { bindVoice = bindVoicePractice } = {}) {
  const get = id => document.getElementById(id);
  const dialog = get("service-dialog"), content = get("service-content");
  const voice = bindVoice(game);
  game.readServices = loadReadServices(localStorage);
  let selected;
  let availabilityEpoch = 0;
  const checkAvailability = async id => {
    if (!voice.getAvailability) return;
    const epoch = ++availabilityEpoch, button = get("service-explain");
    const speechButton = get("service-start-speech"), qaButton = get("service-start-qa"), qaBadge = get("service-qa-badge");
    button.disabled = true;
    button.textContent = "Checking voice tasks...";
    if (speechButton) { speechButton.hidden = true; speechButton.disabled = true; }
    if (qaButton) { qaButton.hidden = true; qaButton.disabled = true; }
    if (qaBadge) qaBadge.hidden = true;
    try {
      const activities = await voice.getAvailability(id);
      if (epoch !== availabilityEpoch || selected !== id) return;
      const readActivities = activities.filter(activity => activity.type === "read_aloud");
      const unlockedRead = readActivities.filter(activity => !activity.onCooldown);
      const reading = unlockedRead.length > 0;
      const readAvailable = readActivities[0]?.availableCount ?? unlockedRead.length;
      const readTotal = readActivities[0]?.totalCount ?? readActivities.length;
      const qaActivities = activities.filter(activity => activity.type === "question_answer" &&
        activity.available === true && activity.languages?.length);
      const unlockedQa = qaActivities.filter(activity => !activity.onCooldown);
      const qa = unlockedQa.length > 0;
      const qaAvailable = qaActivities[0]?.availableCount ?? unlockedQa.length;
      const qaTotal = qaActivities[0]?.totalCount ?? qaActivities.length;
      const hasReadCount = readActivities.some(activity => Number.isInteger(activity.availableCount));
      const hasQaCount = qaActivities.some(activity => Number.isInteger(activity.availableCount));
      const readLabel = hasReadCount ? `Read aloud (${readAvailable}/${readTotal})` : "Read aloud";
      const qaLabel = hasQaCount ? `Q&A (${qaAvailable}/${qaTotal})` : "Q&A";
      button.textContent = reading && qa ? `Available: ${readLabel} / ${qaLabel}`
        : reading ? `Available: ${readLabel}` : qa ? `Available: ${qaLabel}` : "No voice tasks available";
      button.disabled = false;
      if (qaBadge && (readTotal > 0 || qaTotal > 0)) {
        qaBadge.textContent = qaTotal > 0
          ? `Speech: ${readAvailable}/${readTotal} · Q&A: ${qaAvailable}/${qaTotal} available`
          : `Speech: ${readAvailable}/${readTotal} available`;
        qaBadge.hidden = false;
      }
      if (speechButton) {
        speechButton.textContent = `Start Speech (${readAvailable}/${readTotal} available)`;
        speechButton.hidden = !reading;
        speechButton.disabled = !reading;
      }
      if (qaButton) {
        qaButton.textContent = `Start Q&A (${qaAvailable}/${qaTotal} available)`;
        qaButton.hidden = !qa;
        qaButton.disabled = !qa;
      }
    } catch {
      if (epoch !== availabilityEpoch || selected !== id) return;
      button.textContent = "Check voice task availability";
      button.disabled = false;
    }
  };
  game.refreshServiceReader = () => {
    if (!selected) return;
    get("service-read-state").textContent = game.readServices.has(selected) ? "Read" : "New discovery";
    checkAvailability(selected);
  };
  game.refreshVoiceAvailability = () => voice.refreshWorldAvailability?.();
  const serviceAliases = {
    bedrock: "amazon-bedrock",
    stepfunctions: "aws-step-functions",
    "step-functions": "aws-step-functions",
    lakeformation: "aws-lake-formation",
    "lake-formation": "aws-lake-formation",
    ebs: "amazon-elastic-block-store",
    sagemaker: "amazon-sagemaker",
  };
  const showService = rawId => {
    const id = (rawId && serviceAliases[rawId]) || rawId;
    const service = id && Object.hasOwn(AWS_SERVICES, id) ? AWS_SERVICES[id] : null;
    if (!service || !game.ready || game.traveling) return;
    game.guard?.release?.();
    const keys = game.player?.GetComponent?.("BasicCharacterControllerInput")?._keys;
    if (keys) Object.keys(keys).forEach(key => { keys[key] = false; });
    get("service-icon").src = service.icon;
    get("service-title").textContent = service.label;
    get("service-category").textContent = service.category;
    get("service-description").textContent = service.description;
    get("service-example").textContent = service.example;
    get("service-benefit").textContent = service.benefit || "";
    get("service-benefit").hidden = !service.benefit;
    get("service-benefit-heading").hidden = !service.benefit;
    get("service-source").href = service.url;
    selected = id;
    get("service-explain").hidden = false;
    get("service-read-state").textContent = game.readServices.has(id) ? "Read" : "New discovery";
    checkAvailability(id);
    game.readingService = true;
    if (!dialog.open) dialog.showModal();
    content.scrollTop = 0;
  };
  game.showService = showService;
  get("mission-services")?.addEventListener("click", event => {
    const service = event.target.closest("[data-aws-service]")?.dataset.awsService;
    if (service) showService(service);
  });
  document.addEventListener("click", event => {
    const badge = event.target.closest?.("[data-aws-service]");
    if (badge?.dataset?.awsService) {
      showService(badge.dataset.awsService);
      return;
    }
    if (event.target.closest?.(".aws-title-logo")) {
      showService(selected || "s3");
    }
  });
  const logo = document.querySelector(".aws-title-logo");
  if (logo) {
    logo.style.cursor = "pointer";
    logo.title = "Explore AWS Cloud services in AWS Warrior";
  }
  get("service-close").onclick = () => dialog.close();
  get("service-explain").onclick = () => voice.open(selected);
  if (get("service-start-speech")) {
    get("service-start-speech").onclick = () => voice.open(selected, { type: "read_aloud", autoStart: true });
  }
  if (get("service-start-qa")) {
    get("service-start-qa").onclick = () => voice.open(selected, { type: "question_answer", autoStart: true });
  }
  dialog.addEventListener("close", () => {
    game.readingService = Boolean(get("voice-desktop-dialog").open);
    game.refreshServiceReader();
    game.renderer?.domElement?.focus?.();
  });
  const isGameTarget = target => {
    if (!target) return false;
    const canvas = game.renderer?.domElement;
    if (target === canvas) return true;
    const container = document.getElementById("container");
    return target === container || Boolean(container?.contains?.(target));
  };
  const ray = new THREE.Raycaster(), point = new THREE.Vector2();
  const pick = event => {
    if (!event || !game.renderer?.domElement || !game.world?.servicePlaques) return null;
    const bounds = game.renderer.domElement.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    point.set((event.clientX - bounds.left) / bounds.width * 2 - 1,
      -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    if (game.camera) {
      game.camera.updateMatrixWorld?.();
      ray.setFromCamera(point, game.camera);
    }
    const plaques = game.world.servicePlaques.filter(object => object.visible);
    for (const p of plaques) p.updateMatrixWorld?.();
    const hits = ray.intersectObjects(plaques, false);
    for (const hit of hits) {
      if (hit.object?.userData?.awsService) return hit.object;
    }
    return null;
  };
  document.addEventListener("pointermove", event => {
    const canvas = game.renderer?.domElement;
    if (!canvas || !isGameTarget(event.target) || !game.ready || game.traveling) return;
    const object = document.querySelector("dialog[open]") ? null : pick(event);
    const cursor = object ? "pointer" : "";
    canvas.style.cursor = cursor;
    const container = document.getElementById("container");
    if (container) container.style.cursor = cursor;
    const summary = object?.userData?.voiceSummary;
    const summaryText = summary
      ? ` (Speech ${summary.readAvailableCount ?? (summary.readAvailable ? 2 : 0)}/${summary.readTotal ?? 2}${summary.qaTotal > 0 ? ` · Q&A ${summary.qaAvailable}/${summary.qaTotal}` : ""})`
      : "";
    const title = object?.userData?.awsService && AWS_SERVICES[object.userData.awsService]
      ? `${AWS_SERVICES[object.userData.awsService].label}${summaryText}: Click to learn` : "";
    canvas.title = title;
    if (container) container.title = title;
  });
  let pressed;
  document.addEventListener("pointerdown", event => {
    pressed = isGameTarget(event.target) && event.button === 0 ?
      { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
  });
  document.addEventListener("pointercancel", () => { pressed = null; });
  document.addEventListener("pointerup", event => {
    const start = pressed; pressed = null;
    if (!start || start.id !== event.pointerId || event.button !== 0 ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 16 ||
        !isGameTarget(event.target) || !game.ready || game.traveling ||
        document.querySelector("dialog[open]")) return;
    const object = pick(event) || pick(start);
    if (object?.userData?.awsService) showService(object.userData.awsService);
  });
}
