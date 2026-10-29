export const OUTAGE_SITES = {
  village: [
    { x: -92, z: -78, label: "Whispering Forest Edge" },
    { x: 88, z: -82, label: "Crystal Ruins Outpost" },
    { x: -88, z: 74, label: "Western Orchard Node" },
  ],
  mountains: [
    { x: -55, z: -65, label: "Frostpeak North Relay" },
    { x: 58, z: -20, label: "Glacier East Ridge" },
    { x: -48, z: 42, label: "Highland West Pass" },
  ],
  desert: [
    { x: -64, z: -48, label: "Sunspire West Dune" },
    { x: 64, z: -52, label: "Obelisk East Sector" },
    { x: 52, z: 36, label: "Mirage South Basin" },
  ],
  dungeon: [
    { x: -64, z: -64, label: "Northwest Vault Chamber" },
    { x: 64, z: -64, label: "Northeast Vault Chamber" },
    { x: 0, z: -64, label: "Northern Sanctum Core" },
  ],
};

export const OUTAGE_RADIUS = 28;
export const OUTAGE_DURATION = 45;
export const OUTAGE_COOLDOWN = 12;
export const SURGE_DURATION = 25;

export function environmentModifier(mapId, position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
    return { id: null, label: "", speedMultiplier: 1, attackSpeedMultiplier: 1, healPerSecond: 0 };
  }
  if (mapId === "mountains" && position.z < -35) {
    return {
      id: "tailwind",
      label: "Glacial Tailwind (+20% Speed)",
      speedMultiplier: 1.2,
      attackSpeedMultiplier: 1,
      healPerSecond: 0,
    };
  }
  if (mapId === "desert" && Math.hypot(position.x - 45, position.z + 35) <= 20) {
    return {
      id: "oasis",
      label: "Sunspire Oasis (+4 HP/s)",
      speedMultiplier: 1,
      attackSpeedMultiplier: 1,
      healPerSecond: 4,
    };
  }
  if (mapId === "dungeon" && Math.hypot(position.x, position.z) <= 18) {
    return {
      id: "overclock",
      label: "Vault Overclock (+20% Haste)",
      speedMultiplier: 1.15,
      attackSpeedMultiplier: 1.2,
      healPerSecond: 0,
    };
  }
  return { id: null, label: "", speedMultiplier: 1, attackSpeedMultiplier: 1, healPerSecond: 0 };
}

export class WorldEvents {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.reset();
  }

  reset() {
    this.outage = null;
    this.cooldown = OUTAGE_COOLDOWN;
    this.surge = 0;
    this.healCarry = 0;
    this.activeZone = { id: null, label: "", speedMultiplier: 1, attackSpeedMultiplier: 1, healPerSecond: 0 };
  }

  get speedMultiplier() {
    return (this.surge > 0 ? 1.2 : 1) * (this.activeZone.speedMultiplier || 1);
  }

  get attackSpeedMultiplier() {
    return (this.surge > 0 ? 1.2 : 1) * (this.activeZone.attackSpeedMultiplier || 1);
  }

  startOutage(mapId) {
    const sites = OUTAGE_SITES[mapId] || OUTAGE_SITES.village;
    if (!sites.length) return null;
    const site = sites[Math.min(sites.length - 1, Math.floor(this.random() * sites.length))];
    this.outage = {
      mapId,
      x: site.x,
      z: site.z,
      label: site.label,
      radius: OUTAGE_RADIUS,
      remaining: OUTAGE_DURATION,
      progress: 0,
      goal: 2,
    };
    return this.outage;
  }

  recordKill(position) {
    if (!this.outage) return { resolved: false, progressed: false };
    const inside = position && Math.hypot(position.x - this.outage.x, position.z - this.outage.z) <= this.outage.radius;
    this.outage.progress += inside ? 1 : 0.5;
    if (this.outage.progress + 1e-8 >= this.outage.goal) {
      const resolved = this.outage;
      this.outage = null;
      this.cooldown = OUTAGE_COOLDOWN + 8;
      this.surge = SURGE_DURATION;
      return { resolved: true, progressed: true, site: resolved };
    }
    return { resolved: false, progressed: true, site: this.outage };
  }

  update(dt, mapId, playerPos) {
    if (!Number.isFinite(dt) || dt <= 0) return { started: null, expired: null, heal: 0 };
    this.activeZone = environmentModifier(mapId, playerPos);
    let heal = 0;
    if (this.activeZone.healPerSecond > 0) {
      this.healCarry += this.activeZone.healPerSecond * dt;
      heal = Math.floor(this.healCarry);
      this.healCarry -= heal;
    } else {
      this.healCarry = 0;
    }
    if (this.surge > 0) {
      this.surge = Math.max(0, this.surge - dt);
    }
    if (this.outage) {
      if (this.outage.mapId !== mapId) {
        this.outage = null;
        this.cooldown = OUTAGE_COOLDOWN;
        return { started: null, expired: null, heal };
      }
      this.outage.remaining -= dt;
      if (this.outage.remaining <= 0) {
        const expired = this.outage;
        this.outage = null;
        this.cooldown = OUTAGE_COOLDOWN;
        return { started: null, expired, heal };
      }
      return { started: null, expired: null, heal };
    }
    if (this.surge <= 0) {
      this.cooldown -= dt;
      if (this.cooldown <= 0) {
        return { started: this.startOutage(mapId), expired: null, heal };
      }
    }
    return { started: null, expired: null, heal };
  }
}
