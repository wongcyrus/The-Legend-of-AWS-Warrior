export const SHIELDS = {
  Shield_Round: "Round shield",
  Shield_Round_2: "Reinforced round shield",
  Shield_Heater: "Heater shield",
  Shield_Heater_2: "Reinforced heater shield",
  Shield_Celtic_Golden: "Golden Celtic shield",
};

export const PARRY_WINDOW = 0.25;

export class ShieldGuard {
  constructor() {
    this.equipped = false;
    this.held = false;
    this.broken = 0;
    this.parryWindow = 0;
  }

  get active() { return this.equipped && this.held && this.broken <= 0; }
  press() {
    if (!this.held) this.parryWindow = PARRY_WINDOW;
    this.held = true;
  }
  release() {
    this.held = false;
    this.parryWindow = 0;
  }
  update(dt) {
    const step = Math.max(0, dt);
    this.broken = Math.max(0, this.broken - step);
    this.parryWindow = Math.max(0, this.parryWindow - step);
  }

  block(damage, direction, forward, heavy = false) {
    if (!this.active || !direction) return { damage, blocked: false };
    const length = Math.hypot(direction.x, direction.z);
    const facing = Math.hypot(forward.x, forward.z);
    if (!length || !facing ||
        (direction.x * forward.x + direction.z * forward.z) / (length * facing) < Math.cos(Math.PI / 3)) {
      return { damage, blocked: false };
    }
    if (this.parryWindow > 0) {
      this.parryWindow = 0;
      return { damage: 0, blocked: true, broken: false, parried: true };
    }
    if (heavy) {
      this.broken = 1.5;
      this.release();
      return { damage: Math.ceil(damage * 0.5), blocked: true, broken: true };
    }
    return { damage: 0, blocked: true, broken: false };
  }
}
