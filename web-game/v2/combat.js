export const MELEE_RANGE = 5;

export function findMeleeTargets(grid, attacker, range = MELEE_RANGE) {
  const { x, z } = attacker._position;
  return grid.FindNear([x, z], [range * 2, range * 2])
    .filter(client => client.entity !== attacker &&
      Math.hypot(client.entity._position.x - x, client.entity._position.z - z) <= range);
}

export function findMovementBlockers(grid, actor, position, from = actor._position) {
  return grid.FindNear([position.x, position.z], [8, 8])
    .filter(({ entity: other }) => {
      if (other === actor || other.GetComponent("HealthComponent")?.IsAlive() === false) return false;
      const distance = Math.hypot(position.x - other._position.x, position.z - other._position.z);
      // Existing overlaps must allow escape, but never movement deeper into an actor.
      return distance <= 4 && distance < Math.hypot(from.x - other._position.x, from.z - other._position.z);
    }).map(client => client.entity);
}
