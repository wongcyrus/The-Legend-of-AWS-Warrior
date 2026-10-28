import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { FBXLoader } from "https://cdn.jsdelivr.net/npm/three@0.118.1/examples/jsm/loaders/FBXLoader.js";
import { SkeletonUtils } from "https://cdn.jsdelivr.net/npm/three@0.118.1/examples/jsm/utils/SkeletonUtils.js";
import { monsterAnimations } from "./monsters.js?v=20261028-magic-1";

export class MonsterModels {
  constructor() {
    this.manager = new THREE.LoadingManager();
    this.pending = new Map();
    this.templates = new Map();
  }

  ready(names) { return names.every(name => this.templates.has(name)); }

  prepare(names) { return Promise.all([...new Set(names)].map(name => this.load(name))); }

  load(name) {
    if (!this.pending.has(name)) {
      const pending = Promise.all([
        new Promise((resolve, reject) => new FBXLoader(this.manager).load(
          `./resources/monsters/FBX/${name}.fbx`, resolve, undefined, reject)),
        new Promise((resolve, reject) => new THREE.TextureLoader(this.manager).load(
          `./resources/monsters/Textures/${name}_Texture.png`, resolve, undefined, reject)),
      ]).then(([model, texture]) => {
        monsterAnimations(model.animations);
        texture.encoding = THREE.sRGBEncoding;
        texture.flipY = true;
        model.traverse(child => {
          child.castShadow = child.receiveShadow = true;
          for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
            if (!material) continue;
            material.map = texture;
            material.side = THREE.DoubleSide;
          }
        });
        this.templates.set(name, model);
        return model;
      }).catch(error => {
        this.pending.delete(name);
        throw error;
      });
      this.pending.set(name, pending);
    }
    return this.pending.get(name);
  }

  create(name) {
    const template = this.templates.get(name);
    const model = SkeletonUtils.clone(template);
    const materials = new Map();
    const clone = material => {
      if (!materials.has(material)) materials.set(material, material.clone());
      return materials.get(material);
    };
    model.traverse(child => {
      if (child.material) child.material = Array.isArray(child.material)
        ? child.material.map(clone) : clone(child.material);
    });
    return { model, animations: monsterAnimations(template.animations) };
  }

  release(model) {
    model.parent?.remove(model);
    const materials = new Set(), skeletons = new Set();
    model.traverse(child => {
      if (child.skeleton) skeletons.add(child.skeleton);
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (material) materials.add(material);
      }
    });
    materials.forEach(material => material.dispose());
    skeletons.forEach(skeleton => skeleton.boneTexture?.dispose());
  }
}
