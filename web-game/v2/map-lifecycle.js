function materialTextures(material) {
  const textures = [];
  for (const value of Object.values(material)) if (value?.isTexture) textures.push(value);
  for (const uniform of Object.values(material.uniforms || {})) {
    if (uniform?.value?.isTexture) textures.push(uniform.value);
  }
  return textures;
}

export function sharedResources(models) {
  const resources = { geometries: new Set(), materials: new Set(), textures: new Set() };
  for (const model of Object.values(models)) {
    model.traverse(object => {
      if (object.geometry) resources.geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material) continue;
        resources.materials.add(material);
        for (const texture of materialTextures(material)) resources.textures.add(texture);
      }
    });
  }
  return resources;
}

export function disposeMap(root, shared) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry && !shared.geometries.has(object.geometry)) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material || shared.materials.has(material)) continue;
      materials.add(material);
      for (const texture of materialTextures(material)) {
        if (!shared.textures.has(texture)) textures.add(texture);
      }
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => texture.dispose());
  root.parent?.remove(root);
  while (root.children.length) root.remove(root.children[root.children.length - 1]);
}

export function disposeLevelUpEffect(effect, manager) {
  const component = effect?.GetComponent?.("LevelUpComponent");
  if (!component) return false;
  const particles = component._particles;
  particles?._points?.parent?.remove(particles._points);
  particles?._geometry?.dispose?.();
  for (const texture of materialTextures(particles?._material || {})) texture.dispose?.();
  particles?._material?.dispose?.();
  effect.SetActive?.(false);
  if (manager?._entitiesMap && effect.Name) delete manager._entitiesMap[effect.Name];
  return true;
}

export function cleanupExpiredEffects(manager, force = false) {
  if (!manager?._entitiesMap) return 0;
  let cleaned = 0;
  for (const effect of Object.values(manager._entitiesMap)) {
    if (!effect.GetComponent?.("LevelUpComponent")) continue;
    if (force || effect._active === false) {
      if (disposeLevelUpEffect(effect, manager)) cleaned++;
    }
  }
  return cleaned;
}
