export const MELEE_RANGE = 5;

export function findMeleeTargets(grid, attacker) {
  const { x, z } = attacker._position;
  return grid.FindNear([x, z], [MELEE_RANGE * 2, MELEE_RANGE * 2])
    .filter(client => client.entity !== attacker &&
      Math.hypot(client.entity._position.x - x, client.entity._position.z - z) <= MELEE_RANGE);
}
