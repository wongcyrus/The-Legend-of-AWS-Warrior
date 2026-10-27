export const GUIDE_ROAM_RADIUS = 6;
export const GUIDE_WALK_SPEED = 1.5;

export class GuidePatrol {
  constructor({ home, canStep, random = Math.random }) {
    this.home = { x: home.x, z: home.z };
    this.position = { ...this.home };
    this.canStep = canStep;
    this.random = random;
    this.target = null;
    this.wait = 0.5 + random() * 2;
    this.walking = false;
    this.heading = 0;
  }

  update(dt, paused = false) {
    this.walking = false;
    if (paused || dt <= 0) return;
    dt = Math.min(dt, 0.1);
    if (this.wait > 0) {
      this.wait = Math.max(0, this.wait - dt);
      return;
    }
    if (!this.target) {
      const angle = this.random() * Math.PI * 2;
      const radius = 2 + this.random() * (GUIDE_ROAM_RADIUS - 2);
      const target = { x: this.home.x + Math.cos(angle) * radius, z: this.home.z + Math.sin(angle) * radius };
      if (!this.canStep(target.x, target.z)) {
        this.wait = 0.5;
        return;
      }
      this.target = target;
    }
    const dx = this.target.x - this.position.x, dz = this.target.z - this.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.05) {
      this.target = null;
      this.wait = 1 + this.random() * 3;
      return;
    }
    const step = Math.min(GUIDE_WALK_SPEED * dt, distance);
    const x = this.position.x + dx / distance * step, z = this.position.z + dz / distance * step;
    if (!this.canStep(x, z)) {
      this.target = null;
      this.wait = 0.5;
      return;
    }
    this.position = { x, z };
    this.heading = Math.atan2(dx, dz);
    this.walking = true;
  }
}
