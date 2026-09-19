import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  Vector3
} from 'three';
import { ZSphereGraph } from '../demo/ZSphereGraph.js';
import {
  applyAutoSkinWeights,
  applyEnvelopeSkinWeights,
  buildSkeletonFromSpec,
  createBoundPreview,
  skeletonSpecFromGraphState
} from '../demo/ZSphereBind.js';

function chainGraph() {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const root = graph.createRootJoint(new Vector3(0, 1, 0), { radius: 0.08 });
  const mid = graph.createJoint(new Vector3(0, 1.4, 0), {
    parentJointId: root.id,
    radius: 0.06,
    applySymmetry: false
  });
  const tip = graph.createJoint(new Vector3(0, 1.8, 0), {
    parentJointId: mid.id,
    radius: 0.05,
    applySymmetry: false
  });
  return { graph, root, mid, tip, state: graph.captureState() };
}

test('skeletonSpecFromGraphState keeps joints only and parent edges', () => {
  const { graph, root, mid, tip, state } = chainGraph();
  assert.ok(graph.edges.size >= 1);
  assert.ok([...graph.nodes.values()].some((n) => n.role === 'link'));

  const spec = skeletonSpecFromGraphState(state);
  assert.equal(spec.bones.length, 3);
  assert.equal(spec.bones.some((b) => String(b.id).startsWith('link')), false);
  const byId = Object.fromEntries(spec.bones.map((b) => [b.id, b]));
  assert.equal(byId[root.id].parentId, null);
  assert.equal(byId[mid.id].parentId, root.id);
  assert.equal(byId[tip.id].parentId, mid.id);
  assert.ok(byId[mid.id].envelopeRadius > 0);
  graph.dispose();
});

test('buildSkeletonFromSpec creates a parented Bone tree', () => {
  const { graph, root, mid, tip, state } = chainGraph();
  const spec = skeletonSpecFromGraphState(state);
  const { skeleton, boneMap, armature } = buildSkeletonFromSpec(spec);
  assert.equal(skeleton.bones.length, 4); // 3 joints + static uncovered
  assert.ok(skeleton.bones.some((b) => b.userData.staticUncovered));
  assert.equal(boneMap.get(mid.id).parent, boneMap.get(root.id));
  assert.equal(boneMap.get(tip.id).parent, boneMap.get(mid.id));
  armature.updateMatrixWorld(true);
  const tipWorld = new Vector3().setFromMatrixPosition(boneMap.get(tip.id).matrixWorld);
  assert.ok(Math.abs(tipWorld.y - 1.8) < 1e-6);
  graph.dispose();
});

test('applyEnvelopeSkinWeights writes normalized top-4 influences', () => {
  const { graph, state } = chainGraph();
  const spec = skeletonSpecFromGraphState(state);
  const { skeleton } = buildSkeletonFromSpec(spec);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 1.0, 0,
    0, 1.4, 0,
    0, 1.8, 0,
    0.5, 1.4, 0
  ]), 3));

  const stats = applyEnvelopeSkinWeights(geometry, spec, skeleton);
  assert.equal(stats.vertexCount, 4);
  assert.equal(stats.boneCount, 4); // includes static uncovered
  assert.ok(stats.segmentCount >= 2);

  const weights = geometry.getAttribute('skinWeight');
  for (let i = 0; i < 4; i += 1) {
    const sum = weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i);
    assert.ok(Math.abs(sum - 1) < 1e-4, 'weights must sum to 1');
  }

  // Vertex on the mid joint should prefer the mid bone.
  const midIndex = skeleton.bones.findIndex((b) => b.userData.jointId && state.joints[1]
    && b.userData.jointId === state.joints.find((j) => Math.abs(j.y - 1.4) < 1e-6)?.id);
  assert.ok(midIndex >= 0);
  assert.equal(geometry.getAttribute('skinIndex').getX(1), midIndex);
  assert.ok(geometry.getAttribute('skinWeight').getX(1) > 0.5);
  graph.dispose();
});

test('createBoundPreview skins a mesh without mutating the source', () => {
  const { graph, state } = chainGraph();
  // Indexed box so voxel bind can run (non-indexed tiny tris also ok via fallback).
  const geometry = new BufferGeometry();
  const x = 0.1;
  const positions = new Float32Array([
    -x, 1.0, -x, x, 1.0, -x, x, 1.0, x, -x, 1.0, x,
    -x, 1.8, -x, x, 1.8, -x, x, 1.8, x, -x, 1.8, x
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0
  ]);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.position.set(0, 0, 0);
  mesh.updateMatrixWorld(true);

  const preview = createBoundPreview({
    graphState: state,
    meshRoot: mesh,
    meshes: [mesh]
  });

  assert.equal(preview.skinnedMeshes.length, 1);
  assert.ok(preview.skinnedMeshes[0].isSkinnedMesh);
  assert.ok(preview.skinnedMeshes[0].geometry.getAttribute('skinWeight'));
  assert.equal(geometry.getAttribute('skinWeight'), undefined);
  assert.ok(
    preview.weightStats[0].method === 'voxelBind'
      || preview.weightStats[0].method === 'envelopeFallback'
  );

  // Pose a bone — bind matrices stay valid.
  const tipBone = preview.bones.find((b) => !b.userData?.staticUncovered)
    || preview.bones[0];
  tipBone.rotation.z = 0.4;
  tipBone.updateMatrixWorld(true);
  preview.skeleton.update();

  preview.dispose();
  graph.dispose();
});
