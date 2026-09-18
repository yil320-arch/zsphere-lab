import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import { ZSphereGraph } from '../demo/ZSphereGraph.js';
import { ZSphereHistory } from '../demo/ZSphereHistory.js';

test('ZSphereHistory undo/redo restores prior graph snapshots', () => {
  const graph = new ZSphereGraph();
  const history = new ZSphereHistory();

  history.push('root', graph.captureState());
  const root = graph.createRootJoint(new Vector3(0, 1, 0));

  history.push('child', graph.captureState());
  graph.createJoint(new Vector3(0.2, 1.2, 0), { parentJointId: root.id });
  assert.equal([...graph.nodes.values()].filter((n) => n.role === 'joint').length, 3);

  const undone = history.undo(
    () => graph.captureState(),
    (state) => graph.restoreState(state)
  );
  assert.equal(undone, 'child');
  assert.equal([...graph.nodes.values()].filter((n) => n.role === 'joint').length, 1);
  assert.equal(graph.nodes.has(root.id), true);

  const redone = history.redo(
    () => graph.captureState(),
    (state) => graph.restoreState(state)
  );
  assert.equal(redone, 'child');
  assert.equal([...graph.nodes.values()].filter((n) => n.role === 'joint').length, 3);

  history.undo(
    () => graph.captureState(),
    (state) => graph.restoreState(state)
  );
  history.undo(
    () => graph.captureState(),
    (state) => graph.restoreState(state)
  );
  assert.equal([...graph.nodes.values()].filter((n) => n.role === 'joint').length, 0);
  graph.dispose();
});
