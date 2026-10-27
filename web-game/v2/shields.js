export const SHIELDS = {
  Shield_Round: "Round shield",
  Shield_Round_2: "Reinforced round shield",
  Shield_Heater: "Heater shield",
  Shield_Heater_2: "Reinforced heater shield",
  Shield_Celtic_Golden: "Golden Celtic shield",
};

export class ShieldGuard {
  constructor() {
    this.equipped = false;
    this.held = false;
    this.broken = 0;
  }

  get active() { return this.equipped && this.held && this.broken <= 0; }
  release() { this.held = false; }
  update(dt) { this.broken = Math.max(0, this.broken - Math.max(0, dt)); }

  block(damage, direction, forward, heavy = false) {
    if (!this.active || !direction) return { damage, blocked: false };
    const length = Math.hypot(direction.x, direction.z);
    const facing = Math.hypot(forward.x, forward.z);
    if (!length || !facing ||
        (direction.x * forward.x + direction.z * forward.z) / (length * facing) < Math.cos(Math.PI / 3)) {
      return { damage, blocked: false };
    }
    if (heavy) {
      this.broken = 1.5;
      this.release();
      return { damage: Math.ceil(damage * 0.5), blocked: true, broken: true };
    }
    return { damage: 0, blocked: true, broken: false };
  }
}
