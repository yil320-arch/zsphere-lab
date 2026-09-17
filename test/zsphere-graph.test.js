import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import {
  DEFAULT_JOINT_RADIUS,
  ZSphereGraph,
  planLinkChain
} from '../demo/ZSphereGraph.js';

function joints(graph) {
  return [...graph.nodes.values()].filter((node) => node.role === 'joint');
}

test('symmetry creates a stable mirrored Joint pair under a bound center parent', () => {
  const graph = new ZSphereGraph();
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const joint = graph.createJoint(new Vector3(0.2, 1.2, 0), { parentJointId: root.id });
  const mirror = graph.nodes.get(joint.mirrorOf);
  assert.equal(root.symmetryBound, true);
  assert.equal(joint.symmetryBound, true);
  assert.equal(joints(graph).length, 3);
  assert.equal(mirror?.mirrorOf, joint.id);
  assert.equal(mirror?.symmetryBound, true);
  assert.ok(Math.abs(mirror.position.x + joint.position.x) < 1e-6);
  assert.equal(mirror.parentId, root.id);
  graph.dispose();
});

test('unbound asymmetric parents do not spawn mirror children even when symmetry is on', () => {
  const graph = new ZSphereGraph();
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  graph.setSymmetry(false);
  const asymmetric = graph.createJoint(new Vector3(0.35, 1.25, 0), {
    parentJointId: root.id,
    applySymmetry: false
  });
  assert.equal(asymmetric.symmetryBound, false);
  assert.equal(asymmetric.mirrorOf, null);
  assert.equal(joints(graph).length, 2);

  graph.setSymmetry(true);
  const before = joints(graph).length;
  const child = graph.createJoint(new Vector3(0.5, 1.4, 0.1), {
    parentJointId: asymmetric.id
  });
  assert.ok(child);
  assert.equal(child.symmetryBound, false);
  assert.equal(child.mirrorOf, null);
  assert.equal(joints(graph).length, before + 1);
  assert.equal(child.parentId, asymmetric.id);
  graph.dispose();
});

test('directed parent-child hierarchy drives an adaptive sphere-only Link chain', () => {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const parent = graph.createRootJoint(new Vector3(0, 1, 0));
  const child = graph.createJoint(new Vector3(0, 1.55, 0), {
    parentJointId: parent.id,
    applySymmetry: false
  });
  const edge = [...graph.edges.values()][0];
  assert.equal(child.parentId, parent.id);
  assert.equal(parent.childIds.has(child.id), true);
  assert.equal(edge.parentId, parent.id);
  assert.equal(edge.childId, child.id);
  assert.ok(edge.linkIds.length > 3);
  assert.equal(
    [...graph.root.children].some((object) => object.geometry?.type === 'CylinderGeometry'),
    false
  );
  graph.dispose();
});

test('planLinkChain fills an imaginary frustum with dense overlapping Links', () => {
  const collapsed = planLinkChain(
    new Vector3(0, 0, 0), DEFAULT_JOINT_RADIUS,
    new Vector3(0, DEFAULT_JOINT_RADIUS * 0.4, 0), DEFAULT_JOINT_RADIUS
  );
  const short = planLinkChain(
    new Vector3(0, 0, 0), DEFAULT_JOINT_RADIUS,
    new Vector3(0, 0.18, 0), DEFAULT_JOINT_RADIUS
  );
  const long = planLinkChain(
    new Vector3(0, 0, 0), DEFAULT_JOINT_RADIUS,
    new Vector3(0, 0.8, 0), DEFAULT_JOINT_RADIUS
  );
  const taper = planLinkChain(
    new Vector3(0, 0, 0), 0.1,
    new Vector3(0, 0.55, 0), 0.04
  );

  assert.equal(collapsed.count, 0);
  assert.ok(short.count >= 1);
  assert.ok(long.count > short.count);
  assert.equal(long.samples.length, long.count);

  // Frustum radii: first sample near ra, last near rb — not a shrunk constant.
  assert.ok(taper.samples[0].radius > taper.samples[taper.samples.length - 1].radius);
  assert.ok(taper.samples[0].radius > 0.07);
  assert.ok(taper.samples[taper.samples.length - 1].radius < 0.06);

  // Adjacent Links must overlap (chrysalis), not sit as discrete beads.
  for (let i = 1; i < long.samples.length; i += 1) {
    const a = long.samples[i - 1];
    const b = long.samples[i];
    const gap = a.position.distanceTo(b.position);
    assert.ok(gap < a.radius + b.radius - 1e-6);
  }
});

test('Q Draw places the child center at the exact picked parent-surface point', () => {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const pickedSurfacePoint = new Vector3(root.radius, 1, 0);
  const child = graph.extrudeJointFromSurface(root.id, pickedSurfacePoint, {
    radius: DEFAULT_JOINT_RADIUS,
    applySymmetry: false
  });
  const fixedPosition = child.position.clone();
  assert.ok(child.position.distanceTo(pickedSurfacePoint) < 1e-9);
  assert.equal(child.parentId, root.id);
  graph.updateDraftJoint(child.id, DEFAULT_JOINT_RADIUS * 1.7, { applySymmetry: false });
  assert.ok(child.position.distanceTo(fixedPosition) < 1e-9);
  assert.equal(child.radius, DEFAULT_JOINT_RADIUS * 1.7);
  graph.finalizeDraftJoint(child.id);
  assert.equal(child._drawParentId, undefined);
  graph.dispose();
});

test('Q on a Link promotes it to a Joint and splits one directed edge into two', () => {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const parent = graph.createRootJoint(new Vector3(0, 1, 0));
  const child = graph.createJoint(new Vector3(0, 1.6, 0), {
    parentJointId: parent.id,
    applySymmetry: false
  });
  const edge = [...graph.edges.values()][0];
  const promoted = graph.promoteLinkToJoint(
    edge.linkIds[Math.floor(edge.linkIds.length / 2)],
    { applySymmetry: false }
  );
  assert.equal(joints(graph).length, 3);
  assert.equal(graph.edges.size, 2);
  assert.equal(promoted.parentId, parent.id);
  assert.equal(child.parentId, promoted.id);
  assert.equal(parent.childIds.has(promoted.id), true);
  assert.equal(promoted.childIds.has(child.id), true);
  graph.dispose();
});

test('moving one Joint leaves every other Joint fixed and regenerates Links', () => {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const parent = graph.createRootJoint(new Vector3(0, 1, 0));
  const child = graph.createJoint(new Vector3(0, 1.4, 0), {
    parentJointId: parent.id,
    applySymmetry: false
  });
  const parentBefore = parent.position.clone();
  const linksBefore = [...graph.edges.values()][0].linkIds.length;
  graph.moveJoint(child.id, new Vector3(0.5, 1.9, 0), { applySymmetry: false });
  const edge = [...graph.edges.values()][0];
  assert.ok(parent.position.distanceTo(parentBefore) < 1e-9);
  assert.ok(edge.linkIds.length > linksBefore);
  assert.ok(graph.nodes.get(edge.linkIds[0]).position.y > parent.position.y);
  graph.dispose();
});

test('Link Spheres reject scale and delete operations', () => {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const parent = graph.createRootJoint(new Vector3(0, 1, 0));
  graph.createJoint(new Vector3(0, 1.5, 0), {
    parentJointId: parent.id,
    applySymmetry: false
  });
  const edge = [...graph.edges.values()][0];
  const link = graph.nodes.get(edge.linkIds[0]);
  const radiusBefore = link.radius;
  const nodesBefore = graph.nodes.size;
  assert.equal(graph.setRadius(link.id, radiusBefore * 2, { applySymmetry: false }), false);
  graph.select(link.id);
  assert.equal(graph.deleteSelected({ applySymmetry: false }), false);
  assert.equal(link.radius, radiusBefore);
  assert.equal(graph.nodes.size, nodesBefore);
  assert.equal(graph.edges.size, 1);
  graph.dispose();
});

test('center-create mode grows a single on-axis child from a center parent', () => {
  const graph = new ZSphereGraph();
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  assert.equal(graph.isCenterJoint(root), true);

  const side = graph.createJoint(new Vector3(0.3, 1.2, 0), { parentJointId: root.id });
  assert.equal(
    graph.extrudeCenterJointFromSurface(side.id, new Vector3(0.3, 1.25, 0)),
    null
  );

  const before = joints(graph).length;
  const spine = graph.extrudeCenterJointFromSurface(
    root.id,
    new Vector3(0.2, 1 + root.radius, 0.1),
    { radius: DEFAULT_JOINT_RADIUS }
  );
  assert.ok(spine);
  assert.equal(graph.isCenterJoint(spine), true);
  assert.ok(Math.abs(spine.position.x) < 1e-9);
  assert.equal(joints(graph).length, before + 1);
  assert.equal(joints(graph).filter((node) => graph.isCenterJoint(node)).length, 2);
  graph.dispose();
});

test('center joints stay on the symmetry plane while moving', () => {
  const graph = new ZSphereGraph();
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const spine = graph.extrudeCenterJointFromSurface(
    root.id,
    new Vector3(0, 1 + root.radius, 0)
  );
  graph.moveJoint(spine.id, new Vector3(0.4, 1.5, 0.2));
  assert.ok(Math.abs(spine.position.x) < 1e-9);
  assert.equal(spine.position.y, 1.5);
  assert.equal(spine.position.z, 0.2);
  assert.equal(graph.isCenterJoint(spine), true);
  graph.dispose();
});

test('symmetry mirrors hierarchy, move and scale while preserving a single midline root', () => {
  const graph = new ZSphereGraph();
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const child = graph.createJoint(new Vector3(0.3, 1.4, 0), { parentJointId: root.id });
  const mirror = graph.nodes.get(child.mirrorOf);
  assert.equal(root.mirrorOf, root.id);
  assert.equal(root.symmetryBound, true);
  assert.equal(child.symmetryBound, true);
  assert.equal(joints(graph).length, 3);
  assert.equal(graph.edges.size, 2);
  assert.equal(child.parentId, root.id);
  assert.equal(mirror.parentId, root.id);
  graph.moveJoint(child.id, new Vector3(0.45, 1.7, 0.2));
  assert.deepEqual(mirror.position.toArray(), [-0.45, 1.7, 0.2]);
  graph.setRadius(child.id, 0.09);
  assert.equal(mirror.radius, 0.09);
  graph.moveJoint(root.id, new Vector3(0.8, 1.2, 0));
  assert.equal(root.position.x, 0);
  graph.dispose();
});

test('symmetric Link promotion inserts a mirrored Joint pair and preserves both hierarchies', () => {
  const graph = new ZSphereGraph();
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const child = graph.createJoint(new Vector3(0.45, 1.5, 0), { parentJointId: root.id });
  const edge = graph.edges.get(root.id + '>' + child.id);
  const promoted = graph.promoteLinkToJoint(edge.linkIds[Math.floor(edge.linkIds.length / 2)]);
  const mirrorPromoted = graph.nodes.get(promoted.mirrorOf);
  const mirrorChild = graph.nodes.get(child.mirrorOf);
  assert.equal(promoted.symmetryBound, true);
  assert.equal(mirrorPromoted.symmetryBound, true);
  assert.equal(joints(graph).length, 5);
  assert.equal(graph.edges.size, 4);
  assert.equal(promoted.parentId, root.id);
  assert.equal(child.parentId, promoted.id);
  assert.equal(mirrorPromoted.parentId, root.id);
  assert.equal(mirrorChild.parentId, mirrorPromoted.id);
  graph.dispose();
});

test('rotateSubtree spins a limb around its parent and keeps descendants rigid', () => {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const arm = graph.createJoint(new Vector3(0.3, 1, 0), {
    parentJointId: root.id,
    applySymmetry: false
  });
  const hand = graph.createJoint(new Vector3(0.5, 1, 0), {
    parentJointId: arm.id,
    applySymmetry: false
  });
  const quat = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  assert.equal(graph.rotateSubtree(arm.id, root.id, quat, { applySymmetry: false }), true);
  assert.ok(Math.abs(arm.position.x) < 1e-6);
  assert.ok(Math.abs(arm.position.z + 0.3) < 1e-5 || Math.abs(arm.position.z - 0.3) < 1e-5);
  const armToHand = hand.position.clone().sub(arm.position);
  assert.ok(Math.abs(armToHand.length() - 0.2) < 1e-5);
  assert.equal(root.position.x, 0);
  graph.dispose();
});

test('rotateSubtree mirrors a symmetry-bound limb without requiring perfect child topology', () => {
  const graph = new ZSphereGraph();
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const arm = graph.createJoint(new Vector3(0.3, 1, 0), { parentJointId: root.id });
  const mirror = graph.nodes.get(arm.mirrorOf);
  // Extra asymmetric grandchild only on the left arm.
  graph.createJoint(new Vector3(0.45, 1.1, 0), {
    parentJointId: arm.id,
    applySymmetry: false
  });
  const beforeMirror = mirror.position.clone();
  const armDist = arm.position.distanceTo(root.position);
  const mirrorDist = mirror.position.distanceTo(root.position);
  const quat = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  assert.equal(graph.rotateSubtree(arm.id, root.id, quat), true);
  assert.ok(mirror.position.distanceTo(beforeMirror) > 0.05);
  assert.ok(Math.abs(arm.position.distanceTo(root.position) - armDist) < 1e-5);
  assert.ok(Math.abs(mirror.position.distanceTo(root.position) - mirrorDist) < 1e-5);
  // Mirror pair stays reflected across the YZ plane.
  assert.ok(Math.abs(mirror.position.x + arm.position.x) < 1e-5);
  assert.ok(Math.abs(mirror.position.y - arm.position.y) < 1e-5);
  assert.ok(Math.abs(mirror.position.z - arm.position.z) < 1e-5);
  graph.dispose();
});

test('center-center rotateSubtree stays on the symmetry plane', () => {
  const graph = new ZSphereGraph();
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const spine = graph.extrudeCenterJointFromSurface(
    root.id,
    new Vector3(0, 1 + root.radius, 0)
  );
  const quat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  assert.equal(graph.rotateSubtree(spine.id, root.id, quat), true);
  assert.ok(Math.abs(spine.position.x) < 1e-9);
  graph.dispose();
});

test('setOrbitCenter only accepts the selected joint parent', () => {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const a = graph.createJoint(new Vector3(0.2, 1.2, 0), {
    parentJointId: root.id,
    applySymmetry: false
  });
  const b = graph.createJoint(new Vector3(0.2, 1.4, 0), {
    parentJointId: a.id,
    applySymmetry: false
  });
  graph.select(b.id);
  assert.equal(graph.setOrbitCenter(root.id), false);
  assert.equal(graph.setOrbitCenter(a.id), true);
  graph.dispose();
});

test('R orbit accepts arbitrary axes and preserves bone length', () => {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const center = graph.createRootJoint(new Vector3(0, 1, 0));
  const tip = graph.createJoint(new Vector3(0.3, 1.2, 0.1), {
    parentJointId: center.id,
    applySymmetry: false
  });
  const distance = tip.position.distanceTo(center.position);
  graph.select(tip.id);
  assert.equal(graph.setOrbitCenter(center.id), true);
  assert.equal(graph.orbitSelected(Math.PI / 3, new Vector3(1, 0, 0), {
    applySymmetry: false
  }), true);
  assert.ok(Math.abs(tip.position.distanceTo(center.position) - distance) < 1e-9);
  graph.dispose();
});

test('deleting an intermediate Joint splices its children back to its parent', () => {
  const graph = new ZSphereGraph();
  graph.setSymmetry(false);
  const root = graph.createRootJoint(new Vector3(0, 1, 0));
  const middle = graph.createJoint(new Vector3(0, 1.5, 0), {
    parentJointId: root.id,
    applySymmetry: false
  });
  const tip = graph.createJoint(new Vector3(0, 2, 0), {
    parentJointId: middle.id,
    applySymmetry: false
  });
  graph.select(middle.id);
  assert.equal(graph.deleteSelected({ applySymmetry: false }), true);
  assert.equal(graph.nodes.has(middle.id), false);
  assert.equal(tip.parentId, root.id);
  assert.equal(root.childIds.has(tip.id), true);
  assert.equal(graph.edges.size, 1);
  graph.dispose();
});
