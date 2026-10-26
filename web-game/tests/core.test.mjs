import assert from 'node:assert/strict';
import test from 'node:test';
import { entity_manager } from '../src/entity-manager.js';
import { finite_state_machine } from '../src/finite-state-machine.js';
import { spatial_hash_grid } from '../src/spatial-hash-grid.js';

function makeEntity(update = () => {}) {
  return {
    SetParent(parent) { this.parent = parent; },
    SetName(name) { this.Name = name; },
    Update: update,
  };
}

test('entities retain their names and can be deactivated and reactivated once', () => {
  const manager = new entity_manager.EntityManager();
  let updates = 0;
  const entity = makeEntity(() => updates++);
  manager.Add(entity, 'player');
  assert.equal(manager.Get('player'), entity);
  assert.equal(entity.parent, manager);
  manager.SetActive(entity, false);
  manager.Update(1);
  assert.equal(updates, 0);
  manager.SetActive(entity, true);
  manager.SetActive(entity, true);
  manager.Update(1);
  assert.equal(updates, 1);
});

test('an entity deactivating itself does not skip the next entity update', () => {
  const manager = new entity_manager.EntityManager();
  const calls = [];
  const first = makeEntity(() => {
    calls.push('first');
    manager.SetActive(first, false);
  });
  manager.Add(first);
  manager.Add(makeEntity(() => calls.push('second')));
  manager.Update(1);
  assert.deepEqual(calls, ['first', 'second']);
});

test('entities deactivated before their turn do not update', () => {
  const manager = new entity_manager.EntityManager();
  const second = makeEntity(() => assert.fail('Inactive entity updated'));
  manager.Add(makeEntity(() => manager.SetActive(second, false)));
  manager.Add(second);
  manager.Update(1);
});

test('entities added during an update begin on the next frame', () => {
  const manager = new entity_manager.EntityManager();
  let updates = 0;
  const added = makeEntity(() => updates++);
  const first = makeEntity(() => {
    manager.Add(added);
    manager.SetActive(first, false);
  });
  manager.Add(first);
  manager.Update(1);
  assert.equal(updates, 0);
  manager.Update(1);
  assert.equal(updates, 1);
});

test('state transitions exit the previous state and avoid reentering the same state', () => {
  const calls = [];
  const machine = new finite_state_machine.FiniteStateMachine();
  class Idle {
    get Name() { return 'idle'; }
    Enter(previous) { calls.push(['idle.enter', previous]); }
    Exit() { calls.push(['idle.exit']); }
    Update(time, input) { calls.push(['idle.update', time, input]); }
  }
  class Walking extends Idle {
    get Name() { return 'walking'; }
    Enter(previous) { calls.push(['walking.enter', previous.Name]); }
  }
  machine._AddState('idle', Idle);
  machine._AddState('walking', Walking);
  machine.Update(1, 'before-start');
  machine.SetState('idle');
  machine.SetState('idle');
  machine.Update(0.5, 'input');
  machine.SetState('walking');
  assert.deepEqual(calls, [
    ['idle.enter', null], ['idle.update', 0.5, 'input'],
    ['idle.exit'], ['walking.enter', 'idle'],
  ]);
});

test('spatial queries deduplicate clients spanning multiple cells', () => {
  const grid = new spatial_hash_grid.SpatialHashGrid([[0, 0], [100, 100]], [10, 10]);
  const client = grid.NewClient([50, 50], [40, 40]);
  assert.deepEqual(grid.FindNear([50, 50], [80, 80]), [client]);
});

test('moving and removing spatial clients updates their query membership', () => {
  const grid = new spatial_hash_grid.SpatialHashGrid([[0, 0], [100, 100]], [10, 10]);
  const client = grid.NewClient([10, 10], [1, 1]);
  client.position = [90, 90];
  grid.UpdateClient(client);
  assert.deepEqual(grid.FindNear([10, 10], [1, 1]), []);
  assert.deepEqual(grid.FindNear([90, 90], [1, 1]), [client]);
  grid.Remove(client);
  assert.deepEqual(grid.FindNear([90, 90], [1, 1]), []);
});

test('spatial queries safely clamp positions beyond the grid bounds', () => {
  const grid = new spatial_hash_grid.SpatialHashGrid([[0, 0], [100, 100]], [10, 10]);
  const client = grid.NewClient([-100, -100], [1, 1]);
  assert.deepEqual(grid.FindNear([-100, -100], [1, 1]), [client]);
  assert.deepEqual(grid.FindNear([200, 200], [1, 1]), []);
});
