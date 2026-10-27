import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.118.1/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "https://cdn.jsdelivr.net/npm/three@0.118.1/examples/jsm/loaders/FBXLoader.js";

export const TOWN_MODELS = [
  "wall", "wall-door", "wall-window-shutters", "wall-wood", "roof-gable",
  "roof-gable-end", "chimney", "fountain-round-detail", "stall-red",
  "stall-green", "stall-bench", "cart", "fence", "fence-broken", "lantern",
  "banner-red", "banner-green", "wall-broken", "wall-arch", "pillar-stone",
  "tree", "tree-high", "tree-crooked", "tree-high-round", "rock-large", "rock-small",
];

export class Assets {
  constructor() {
    this.models = new Map();
    this.gltf = new GLTFLoader();
    this.fbx = new FBXLoader();
  }

  async preload() {
    await Promise.all([
      ...TOWN_MODELS.map(name => this.load(name, `./v2/assets/kenney/${name}.glb`)),
      ...["Grass", "Flowers", "Bush_1"].map(name =>
        this.load(name, `./resources/nature/FBX/${name}.fbx`)),
    ]);
  }

  load(name, url) {
    if (!this.models.has(name)) {
      const loader = url.endsWith(".glb") ? this.gltf : this.fbx;
      this.models.set(name, new Promise((resolve, reject) => {
        loader.load(url, result => {
          const model = result.scene || result;
          model.traverse(child => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            if (url.endsWith(".fbx")) {
              const convert = material => new THREE.MeshStandardMaterial({
                color: material.color,
                map: material.map,
                vertexColors: material.vertexColors,
                roughness: 0.95,
              });
              child.material = Array.isArray(child.material)
                ? child.material.map(convert) : convert(child.material);
            }
          });
          resolve(model);
        }, undefined, () => reject(new Error(`Could not load ${name}. Reload to try again.`)));
      }));
    }
    return this.models.get(name);
  }

  async templates() {
    return Object.fromEntries(await Promise.all(
      [...this.models].map(async ([name, promise]) => [name, await promise])
    ));
  }
}

export function normalized(model, height) {
  const root = new THREE.Group();
  const copy = model.clone(true);
  const bounds = new THREE.Box3().setFromObject(copy);
  const size = bounds.getSize(new THREE.Vector3());
  copy.position.sub(new THREE.Vector3(
    (bounds.min.x + bounds.max.x) / 2, bounds.min.y, (bounds.min.z + bounds.max.z) / 2
  ));
  root.add(copy);
  root.scale.setScalar(height / Math.max(size.y, 0.01));
  root.updateMatrixWorld(true);
  return root;
}

export function instances(parent, model, placements, shadows = true) {
  model.updateMatrixWorld(true);
  const transform = new THREE.Object3D();
  const matrix = new THREE.Matrix4();
  const meshes = [];
  model.traverse(child => {
    if (!child.isMesh) return;
    const mesh = new THREE.InstancedMesh(child.geometry, child.material, placements.length);
    placements.forEach((placement, index) => {
      transform.position.set(placement.x, placement.y || 0, placement.z);
      transform.rotation.set(0, placement.rotation || 0, 0);
      transform.scale.setScalar(placement.scale || 1);
      transform.updateMatrix();
      matrix.multiplyMatrices(transform.matrix, child.matrixWorld);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.needsUpdate = true;
    parent.add(mesh);
    meshes.push(mesh);
  });
  return meshes;
}
