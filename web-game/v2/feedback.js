export class CombatFeedback {
  constructor(container) {
    this.container = container;
    this.numbers = [];
    this.flashes = new Map();
  }

  show(position, text, color = "#ffe0a0") {
    if (this.numbers.length >= 24) this.numbers.shift().element.remove();
    const element = document.createElement("span");
    element.className = "damage-number";
    element.textContent = text;
    element.style.color = color;
    this.container.appendChild(element);
    this.numbers.push({ element, position: position.clone(), life: 0.9 });
  }

  flash(model) {
    if (!model) return;
    let flash = this.flashes.get(model);
    if (!flash) {
      const materials = new Set();
      model.traverse(object => {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (material?.emissive) materials.add(material);
        }
      });
      flash = { materials: [...materials].map(material => ({ material, color: material.emissive.clone() })) };
      this.flashes.set(model, flash);
    }
    flash.life = 0.12;
    flash.materials.forEach(({ material }) => material.emissive.setHex(0x887755));
  }

  update(dt, project) {
    this.numbers = this.numbers.filter(number => {
      number.life -= dt;
      if (number.life <= 0) { number.element.remove(); return false; }
      number.position.y += dt * 3;
      const point = project(number.position);
      number.element.hidden = point.z < -1 || point.z > 1;
      number.element.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
      number.element.style.opacity = Math.min(1, number.life * 3);
      return true;
    });
    for (const [model, flash] of this.flashes) {
      flash.life -= dt;
      if (flash.life <= 0) {
        flash.materials.forEach(({ material, color }) => material.emissive.copy(color));
        this.flashes.delete(model);
      }
    }
  }
}
