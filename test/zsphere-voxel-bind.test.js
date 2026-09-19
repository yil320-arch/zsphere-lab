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
  buildSkeletonFromSpec,
  createBoundPreview,
  skeletonSpecFromGraphState,
  STATIC_UNCOVERED_BONE_ID
} from '../demo/ZSphereBind.js';
import { voxelBindWeights } from '../demo/ZSphereVoxelBind.js';

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

/** Closed capsule-like prism around the Y chain for voxel fill. */
function limbPrismGeometry() {
  const geometry = new BufferGeometry();
  // 8-corner box from y=0.95..1.85, thin in XZ — encloses the bone chain.
  const x = 0.12;
  const z = 0.12;
  const y0 = 0.95;
  const y1 = 1.85;
  const positions = new Float32Array([
    -x, y0, -z,  x, y0, -z,  x, y0,  z, -x, y0,  z,
    -x, y1, -z,  x, y1, -z,  x, y1,  z, -x, y1,  z
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0
  ]);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/** Two disconnected boxes: short leg chain + far "hand" — mimics legs-only rig. */
function legAndHandGeometry() {
  const geometry = new BufferGeometry();
  // Leg box around hip(0,0,0)→knee(0,-0.3,0)→ankle(0,-0.6,0)
  const lx = 0.1;
  const lz = 0.1;
  const ly0 = -0.7;
  const ly1 = 0.08;
  // Hand box far to the +X — beyond local capture of short leg bones
  const hx = 1.2;
  const hw = 0.08;
  const hy0 = 0.35;
  const hy1 = 0.55;
  const hz = 0.08;
  const positions = new Float32Array([
    // leg 0..7
    -lx, ly0, -lz,  lx, ly0, -lz,  lx, ly0,  lz, -lx, ly0,  lz,
    -lx, ly1, -lz,  lx, ly1, -lz,  lx, ly1,  lz, -lx, ly1,  lz,
    // hand 8..15
    hx - hw, hy0, -hz,  hx + hw, hy0, -hz,  hx + hw, hy0,  hz, hx - hw, hy0,  hz,
    hx - hw, hy1, -hz,  hx + hw, hy1, -hz,  hx + hw, hy1,  hz, hx - hw, hy1,  hz
  ]);
  const boxFaces = (o) => [
    o + 0, o + 1, o + 2, o + 0, o + 2, o + 3,
    o + 4, o + 6, o + 5, o + 4, o + 7, o + 6,
    o + 0, o + 4, o + 5, o + 0, o + 5, o + 1,
    o + 1, o + 5, o + 6, o + 1, o + 6, o + 2,
    o + 2, o + 6, o + 7, o + 2, o + 7, o + 3,
    o + 3, o + 7, o + 4, o + 3, o + 4, o + 0
  ];
  const indices = new Uint16Array([...boxFaces(0), ...boxFaces(8)]);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function legsOnlyGraph() {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const hip = graph.createRootJoint(new Vector3(0, 0, 0), { radius: 0.06 });
  const knee = graph.createJoint(new Vector3(0, -0.3, 0), {
    parentJointId: hip.id,
    radius: 0.05,
    applySymmetry: false
  });
  const ankle = graph.createJoint(new Vector3(0, -0.6, 0), {
    parentJointId: knee.id,
    radius: 0.04,
    applySymmetry: false
  });
  return { graph, hip, knee, ankle, state: graph.captureState() };
}

test('voxelBindWeights keeps normalized top-4 and prefers local bone', () => {
  const { graph, mid, tip, state } = chainGraph();
  const spec = skeletonSpecFromGraphState(state);
  const { skeleton } = buildSkeletonFromSpec(spec);
  const geometry = limbPrismGeometry();
  const stats = applyAutoSkinWeights(geometry, spec, skeleton, { maxResolution: 32 });
  assert.equal(stats.method, 'voxelBind');
  assert.equal(stats.poseBoneCount, 3);
  assert.equal(stats.boneCount, 4); // + static uncovered
  assert.ok(stats.grid.solidCount > 0);

  const weights = geometry.getAttribute('skinWeight');
  const indices = geometry.getAttribute('skinIndex');
  for (let i = 0; i < weights.count; i += 1) {
    const sum = weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i);
    assert.ok(Math.abs(sum - 1) < 1e-3, 'weights sum ~1');
  }

  const midBone = skeleton.bones.findIndex((b) => b.userData.jointId === mid.id);
  const tipBone = skeleton.bones.findIndex((b) => b.userData.jointId === tip.id);
  assert.ok(midBone >= 0 && tipBone >= 0);

  // Top ring vertices (y≈1.85) should put meaningful weight on tip/mid, not only root.
  let tipOrMidDominant = 0;
  for (let i = 4; i < 8; i += 1) {
    const bi = indices.getX(i);
    if (bi === tipBone || bi === midBone) tipOrMidDominant += 1;
  }
  assert.ok(tipOrMidDominant >= 2, 'upper limb verts should prefer tip/mid over root');
  graph.dispose();
});

test('far hand verts bind to static uncovered bone, not hip', () => {
  const { graph, hip, state } = legsOnlyGraph();
  const spec = skeletonSpecFromGraphState(state);
  const { skeleton } = buildSkeletonFromSpec(spec);
  const geometry = legAndHandGeometry();
  const stats = applyAutoSkinWeights(geometry, spec, skeleton, { maxResolution: 48 });
  assert.equal(stats.method, 'voxelBind');
  assert.ok(stats.uncoveredVertices > 0, 'hand region should be uncovered');

  const staticIdx = skeleton.bones.findIndex((b) => b.userData.staticUncovered);
  const hipIdx = skeleton.bones.findIndex((b) => b.userData.jointId === hip.id);
  assert.equal(skeleton.bones[staticIdx].name, STATIC_UNCOVERED_BONE_ID);
  assert.ok(staticIdx >= 0 && hipIdx >= 0);

  const indices = geometry.getAttribute('skinIndex');
  const weights = geometry.getAttribute('skinWeight');

  let handOnStatic = 0;
  let handOnHip = 0;
  for (let i = 8; i < 16; i += 1) {
    if (indices.getX(i) === staticIdx && weights.getX(i) > 0.9) handOnStatic += 1;
    if (indices.getX(i) === hipIdx && weights.getX(i) > 0.5) handOnHip += 1;
  }
  assert.ok(handOnStatic >= 6, 'most hand verts should rest on static bone');
  assert.equal(handOnHip, 0, 'hand must not be dominated by hip');

  let legOnPoseBone = 0;
  for (let i = 0; i < 8; i += 1) {
    const bi = indices.getX(i);
    if (bi !== staticIdx) legOnPoseBone += 1;
  }
  assert.ok(legOnPoseBone >= 6, 'leg verts should still bind to pose bones');
  graph.dispose();
});

/**
 * U-shaped "crotch": left/right legs close in space, connected only via a top bridge.
 * Left femur must not dominate the right leg (volume short-circuit vs surface walk).
 */
function crotchUGeometry() {
  const geometry = new BufferGeometry();
  const positions = [];
  const indices = [];
  function addBox(x0, x1, y0, y1, z0, z1) {
    const o = positions.length / 3;
    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]
    ];
    for (const c of corners) positions.push(c[0], c[1], c[2]);
    const faces = [
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
      0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
      2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0
    ];
    for (const i of faces) indices.push(o + i);
  }
  // Left leg, right leg (close across x=0), thin bridge at top — like a crotch fold.
  addBox(-0.45, -0.25, -0.7, 0.05, -0.08, 0.08);
  addBox(0.25, 0.45, -0.7, 0.05, -0.08, 0.08);
  addBox(-0.45, 0.45, 0.05, 0.18, -0.08, 0.08);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(new BufferAttribute(new Uint16Array(indices), 1));
  geometry.computeVertexNormals();
  return geometry;
}

function twoLegGraph() {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const hip = graph.createRootJoint(new Vector3(0, 0.1, 0), { radius: 0.05 });
  const leftKnee = graph.createJoint(new Vector3(-0.35, -0.25, 0), {
    parentJointId: hip.id,
    radius: 0.04,
    applySymmetry: false
  });
  const leftAnkle = graph.createJoint(new Vector3(-0.35, -0.55, 0), {
    parentJointId: leftKnee.id,
    radius: 0.035,
    applySymmetry: false
  });
  const rightKnee = graph.createJoint(new Vector3(0.35, -0.25, 0), {
    parentJointId: hip.id,
    radius: 0.04,
    applySymmetry: false
  });
  const rightAnkle = graph.createJoint(new Vector3(0.35, -0.55, 0), {
    parentJointId: rightKnee.id,
    radius: 0.035,
    applySymmetry: false
  });
  return { graph, hip, leftKnee, rightKnee, leftAnkle, rightAnkle, state: graph.captureState() };
}

test('visibility gate: left leg bone does not dominate right leg across crotch air gap', () => {
  const { graph, leftKnee, rightKnee, state } = twoLegGraph();
  const spec = skeletonSpecFromGraphState(state);
  const { skeleton } = buildSkeletonFromSpec(spec);
  const geometry = crotchUGeometry();
  const stats = applyAutoSkinWeights(geometry, spec, skeleton, {
    maxResolution: 48,
    useVisibilityGate: true,
    useSurfaceGate: false
  });
  assert.equal(stats.method, 'voxelBind');
  assert.equal(stats.visibilityGate, true);

  const leftIdx = skeleton.bones.findIndex((b) => b.userData.jointId === leftKnee.id);
  const rightIdx = skeleton.bones.findIndex((b) => b.userData.jointId === rightKnee.id);
  assert.ok(leftIdx >= 0 && rightIdx >= 0);

  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const pos = geometry.getAttribute('position');

  let rightVerts = 0;
  let rightDominatedByLeft = 0;
  for (let i = 0; i < pos.count; i += 1) {
    if (pos.getX(i) < 0.2) continue;
    rightVerts += 1;
    if (skinIndex.getX(i) === leftIdx && skinWeight.getX(i) > 0.35) {
      rightDominatedByLeft += 1;
    }
  }
  assert.ok(rightVerts >= 8, 'expected right-leg verts');
  assert.equal(rightDominatedByLeft, 0, 'right-leg verts must not be dominated by left knee');
  graph.dispose();
});

test('surface gate opt-in: left leg bone does not dominate right leg across crotch', () => {
  const { graph, leftKnee, state } = twoLegGraph();
  const spec = skeletonSpecFromGraphState(state);
  const { skeleton } = buildSkeletonFromSpec(spec);
  const geometry = crotchUGeometry();
  // Opt-in hard surface gate (not used in Lab by default — tore real meshes).
  const stats = applyAutoSkinWeights(geometry, spec, skeleton, {
    maxResolution: 48,
    useSurfaceGate: true,
    useVisibilityGate: false
  });
  assert.equal(stats.method, 'voxelBind');
  assert.equal(stats.surfaceGate, true);

  const leftIdx = skeleton.bones.findIndex((b) => b.userData.jointId === leftKnee.id);
  assert.ok(leftIdx >= 0);

  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const pos = geometry.getAttribute('position');

  let rightDominatedByLeft = 0;
  for (let i = 0; i < pos.count; i += 1) {
    if (pos.getX(i) < 0.2) continue;
    if (skinIndex.getX(i) === leftIdx && skinWeight.getX(i) > 0.35) {
      rightDominatedByLeft += 1;
    }
  }
  assert.equal(rightDominatedByLeft, 0, 'right-leg verts must not be dominated by left knee');
  graph.dispose();
});

test('createBoundPreview uses voxelBind without mutating source', () => {
  const { graph, state } = chainGraph();
  const geometry = limbPrismGeometry();
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.updateMatrixWorld(true);

  const preview = createBoundPreview({
    graphState: state,
    meshRoot: mesh,
    meshes: [mesh]
  });
  assert.equal(preview.weightStats[0].method, 'voxelBind');
  assert.ok(preview.skinnedMeshes[0].geometry.getAttribute('skinWeight'));
  assert.equal(geometry.getAttribute('skinWeight'), undefined);

  const poseBone = preview.bones.find((b) => !b.userData?.staticUncovered);
  poseBone.rotation.z = 0.35;
  preview.armature.updateMatrixWorld(true);
  preview.skeleton.update();

  preview.dispose();
  graph.dispose();
});
