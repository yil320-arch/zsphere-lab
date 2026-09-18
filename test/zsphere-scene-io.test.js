import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import { ZSphereGraph } from '../demo/ZSphereGraph.js';
import {
  SCENE_FORMAT,
  createSceneDocument,
  parseSceneDocument
} from '../demo/ZSphereSceneIO.js';

test('zscene document round-trips graph state and settings', () => {
  const graph = new ZSphereGraph();
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  graph.createJoint(new Vector3(0.2, 1.2, 0), { parentJointId: root.id });
  const doc = createSceneDocument({
    graphState: graph.captureState(),
    settings: {
      symmetry: true,
      xray: false,
      centerCreate: true,
      meshOpacity: 0.4,
      meshVisible: true
    },
    mesh: null
  });
  assert.equal(doc.format, SCENE_FORMAT);
  assert.equal(doc.graph.joints.length, 3);

  const text = JSON.stringify(doc);
  const parsed = parseSceneDocument(text);
  assert.equal(parsed.settings.centerCreate, true);
  assert.equal(parsed.settings.meshOpacity, 0.4);
  assert.equal(parsed.mesh, null);

  const other = new ZSphereGraph();
  assert.equal(other.restoreState(parsed.graph), true);
  assert.equal([...other.nodes.values()].filter((n) => n.role === 'joint').length, 3);
  graph.dispose();
  other.dispose();
});

test('parseSceneDocument rejects unknown formats', () => {
  assert.throws(() => parseSceneDocument({ format: 'other', version: 1, graph: { joints: [] } }));
});

test('bakeWorldTransformsIntoMeshes absorbs uniform scale into geometry', async () => {
  const { Mesh, BoxGeometry, MeshBasicMaterial, Group, Vector3 } = await import('three');
  const { bakeWorldTransformsIntoMeshes } = await import('../demo/ZSphereSceneIO.js');
  const root = new Group();
  const mesh = new Mesh(new BoxGeometry(1, 2, 1), new MeshBasicMaterial());
  root.add(mesh);
  root.scale.setScalar(0.5);
  root.updateMatrixWorld(true);
  bakeWorldTransformsIntoMeshes(root);
  assert.equal(root.scale.x, 1);
  mesh.geometry.computeBoundingBox();
  const size = new Vector3();
  mesh.geometry.boundingBox.getSize(size);
  assert.ok(Math.abs(size.y - 1) < 1e-6, 'height should be 1 after baking 0.5× onto a 2-tall box');
});
