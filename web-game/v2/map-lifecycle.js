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
