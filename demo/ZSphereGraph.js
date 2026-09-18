import {
  BackSide,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  Plane,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three';

const JOINT_COLOR = new Color('#6ee8f0');
const LINK_COLOR = new Color('#1a3036');
const CENTER_COLOR = new Color('#b8a0e8');
const OUTLINE_COLOR = new Color('#c8f6fa');
const ZERO = new Color(0x000000);

const _hsl = { h: 0, s: 0, l: 0 };
const _emphasisColor = new Color();
const _emphasisEmissive = new Color();
const _outlineEmphasis = new Color();

/** Keep hue; raise saturation + lightness for selection (no flat yellow swap). */
function emphasizeColor(base, target = _emphasisColor) {
  target.copy(base).getHSL(_hsl);
  target.setHSL(
    _hsl.h,
    Math.min(1, _hsl.s * 1.35 + 0.1),
    Math.min(0.88, _hsl.l * 1.22 + 0.06)
  );
  return target;
}

function emphasizeEmissive(base, target = _emphasisEmissive) {
  target.copy(base).getHSL(_hsl);
  target.setHSL(_hsl.h, Math.min(1, _hsl.s * 0.9 + 0.05), 0.22);
  return target;
}

function emphasizeOutline(base, target = _outlineEmphasis) {
  target.copy(base).getHSL(_hsl);
  target.setHSL(
    _hsl.h,
    Math.min(1, _hsl.s * 1.1 + 0.05),
    Math.min(0.92, _hsl.l * 1.35 + 0.12)
  );
  return target;
}

const OUTLINE_SCALE = 1.14;
const DEFAULT_JOINT_RADIUS = 0.055;
/**
 * Imaginary frustum sampling: center-to-center step as a fraction of the local
 * cross-section radius. Smaller → denser overlap (chrysalis). ~0.45 keeps heavy nest.
 */
const LINK_SPACING_FACTOR = 0.45;
/**
 * If joint centers are closer than this × min(ra,rb), skip Link fill
 * (avoids packing too many spheres into a collapsed frustum).
 */
const LINK_CLOSE_DIST_FACTOR = 0.55;
const MIN_RADIUS = 0.012;
const MAX_RADIUS = 0.22;
const MAX_LINKS_PER_EDGE = 128;
const SYMMETRY_EPSILON = 1e-4;

const _dir = new Vector3();
const _pos = new Vector3();
const _normal = new Vector3();
const _offset = new Vector3();
const _axis = new Vector3();
const _quat = new Quaternion();
const _mirrorQuat = new Quaternion();

let nextId = 1;
function uid(prefix) {
  return prefix + '_' + (nextId++);
}

function peekNextId() {
  return nextId;
}

function ensureNextIdAtLeast(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > nextId) nextId = Math.floor(n);
}

function clampRadius(radius) {
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius));
}

/**
 * Plan Link Spheres from an imaginary frustum between two joints.
 * End caps are circles through each joint center with that joint's radius.
 * Along the axis, each sample uses the frustum cross-section radius (lerp).
 * Spacing adapts to local radius so spheres stay densely overlapping.
 * The frustum is computational only — never rendered.
 */
export function planLinkChain(aPos, aRadius, bPos, bRadius) {
  const dist = aPos.distanceTo(bPos);
  if (dist < 1e-8) {
    return { count: 0, samples: [] };
  }
  _dir.copy(bPos).sub(aPos).multiplyScalar(1 / dist);
  const ra = clampRadius(aRadius);
  const rb = clampRadius(bRadius);
  const minR = Math.min(ra, rb);

  // Extreme: frustum too short → no intermediate Links (joints already read as one mass).
  if (dist < minR * LINK_CLOSE_DIST_FACTOR) {
    return { count: 0, samples: [] };
  }

  const samples = [];
  let h = 0;
  let guard = 0;
  while (guard++ < MAX_LINKS_PER_EDGE) {
    const t = Math.min(h / dist, 1);
    const rHere = ra + (rb - ra) * t;
    const step = Math.max(MIN_RADIUS * 0.35, rHere * LINK_SPACING_FACTOR);
    h += step;
    if (h >= dist - 1e-8) break;

    const tSample = h / dist;
    // Keep samples off the exact joint centers so Joint meshes own the endpoints.
    if (h < step * 0.25 || dist - h < step * 0.25) continue;

    const radius = clampRadius(ra + (rb - ra) * tSample);
    _pos.copy(aPos).addScaledVector(_dir, h);
    samples.push({ position: _pos.clone(), radius, t: tSample });
  }

  // Short but valid frustum: still show one mid section so the edge isn't empty.
  if (samples.length === 0 && dist >= minR * LINK_CLOSE_DIST_FACTOR) {
    samples.push({
      position: aPos.clone().lerp(bPos, 0.5),
      radius: clampRadius((ra + rb) * 0.5),
      t: 0.5
    });
  }

  return { count: samples.length, samples };
}

/**
 * Freeform ZBrush-like ZSphere graph.
 * Joints connected by adaptive Link Sphere chains from an imaginary frustum.
 * Default shading is physical depth (opaque + depth test/write). Optional x-ray
 * only lowers opacity — it does not disable depth, which caused always-on-top
 * drawing and flicker among densely overlapping Link Spheres.
 */
export class ZSphereGraph {
  constructor({ xray = false } = {}) {
    this.xray = Boolean(xray);
    this.symmetry = true;
    this.root = new Group();
    this.root.name = 'ZSphereGraph';
    this.nodes = new Map();
    this.edges = new Map();
    this.selectedId = null;
    this.orbitCenterId = null;
    this._sphereGeo = new SphereGeometry(1, 28, 20);
    this._outlineGeo = new SphereGeometry(1, 20, 14);
    this._pickables = [];
  }

  setSymmetry(enabled) {
    this.symmetry = Boolean(enabled);
  }

  /** Apply depth / opacity style for physical vs translucent preview. */
  _applySurfaceStyle(material, role) {
    const isLink = role === 'link';
    if (this.xray) {
      material.transparent = true;
      material.opacity = isLink ? 0.42 : 0.55;
      material.depthTest = true;
      material.depthWrite = true;
    } else {
      material.transparent = false;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
    }
    // Tiny bias on links reduces z-fight flicker where Links nest against Joints.
    if (isLink) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 1;
    } else {
      material.polygonOffset = false;
      material.polygonOffsetFactor = 0;
      material.polygonOffsetUnits = 0;
    }
  }

  setXRay(xray) {
    this.xray = Boolean(xray);
    for (const node of this.nodes.values()) {
      this._applySurfaceStyle(node.mesh.material, node.role);
      node.mesh.renderOrder = 0;
      if (node.outline) {
        node.outline.material.depthTest = true;
        node.outline.material.depthWrite = false;
        node.outline.renderOrder = 1;
      }
    }
    this._paintSelection();
  }

  getPickables() {
    return this._pickables;
  }

  getSelected() {
    return this.selectedId ? this.nodes.get(this.selectedId) ?? null : null;
  }

  getOrbitCenter() {
    return this.orbitCenterId ? this.nodes.get(this.orbitCenterId) ?? null : null;
  }

  clear() {
    for (const node of [...this.nodes.values()]) this._disposeNode(node);
    this.nodes.clear();
    this.edges.clear();
    this.selectedId = null;
    this.orbitCenterId = null;
    this._pickables = [];
  }

  /**
   * Snapshot joint topology only — Link chains regenerate on restore.
   * Used by Ctrl+Z history (opaque JSON-safe plain data).
   */
  captureState() {
    const joints = [];
    for (const node of this.nodes.values()) {
      if (node.role !== 'joint') continue;
      joints.push({
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        z: node.position.z,
        radius: node.radius,
        parentId: node.parentId ?? null,
        mirrorOf: node.mirrorOf ?? null,
        symmetryBound: node.symmetryBound === true,
        centerAxis: node.centerAxis === true
      });
    }
    return {
      version: 1,
      nextId: peekNextId(),
      selectedId: this.selectedId,
      joints
    };
  }

  /**
   * Replace the live graph with a previous captureState() snapshot.
   * Clears selection orbit pivot; caller should refresh lab gizmos.
   */
  restoreState(state) {
    if (!state || !Array.isArray(state.joints)) return false;
    this.clear();
    ensureNextIdAtLeast(state.nextId);

    for (const joint of state.joints) {
      if (!joint?.id) continue;
      const node = this._registerNode({
        id: joint.id,
        role: 'joint',
        position: new Vector3(joint.x, joint.y, joint.z),
        radius: clampRadius(joint.radius ?? DEFAULT_JOINT_RADIUS),
        mirrorOf: joint.mirrorOf ?? null,
        parentId: null
      });
      node.symmetryBound = joint.symmetryBound === true;
      node.centerAxis = joint.centerAxis === true;
      node.mirrorOf = joint.mirrorOf ?? null;
    }

    for (const joint of state.joints) {
      if (!joint?.id || !joint.parentId) continue;
      if (!this.nodes.has(joint.id) || !this.nodes.has(joint.parentId)) continue;
      this.connectJoints(joint.parentId, joint.id);
    }

    this.selectedId = state.selectedId && this.nodes.has(state.selectedId)
      ? state.selectedId
      : null;
    this.orbitCenterId = null;
    this._rebuildPickables();
    this._paintSelection();
    return true;
  }

  _mat(color, { dark = false } = {}) {
    const material = new MeshPhongMaterial({
      color: color.clone(),
      emissive: ZERO.clone(),
      specular: new Color(dark ? '#4a6066' : '#b8eef2'),
      shininess: dark ? 28 : 64
    });
    this._applySurfaceStyle(material, dark ? 'link' : 'joint');
    return material;
  }

  _edgeKey(parentId, childId) {
    return parentId + '>' + childId;
  }

  _createMesh(role, radius) {
    const color = role === 'joint' ? JOINT_COLOR : LINK_COLOR;
    const mesh = new Mesh(
      this._sphereGeo,
      this._mat(color, { dark: role === 'link' })
    );
    mesh.scale.setScalar(radius);
    mesh.renderOrder = 0;
    const outline = new Mesh(
      this._outlineGeo,
      new MeshBasicMaterial({
        color: OUTLINE_COLOR,
        side: BackSide,
        transparent: true,
        opacity: 0.9,
        depthTest: true,
        depthWrite: false
      })
    );
    outline.visible = false;
    outline.scale.setScalar(OUTLINE_SCALE);
    outline.renderOrder = 1;
    mesh.add(outline);
    return { mesh, outline };
  }

  _registerNode({
    id,
    role,
    position,
    radius,
    mirrorOf = null,
    parentId = null,
    edgeKey = null,
    edgeT = null
  }) {
    const { mesh, outline } = this._createMesh(role, radius);
    mesh.name = 'ZSphereNode-' + id;
    mesh.position.copy(position);
    mesh.userData.nodeId = id;
    mesh.userData.role = role;
    const node = {
      id,
      role,
      radius,
      mirrorOf: mirrorOf ?? null,
      /** Participates in left/right symmetry pairing when true. */
      symmetryBound: false,
      centerAxis: false,
      parentId: role === 'joint' ? parentId : null,
      childIds: role === 'joint' ? new Set() : null,
      edgeKey: role === 'link' ? edgeKey : null,
      edgeT: role === 'link' ? edgeT : null,
      mesh,
      outline,
      position: mesh.position
    };
    this.nodes.set(id, node);
    this.root.add(mesh);
    this._rebuildPickables();
    return node;
  }

  _disposeNode(node) {
    node.mesh.removeFromParent();
    node.mesh.material.dispose();
    node.outline?.material.dispose();
    this.nodes.delete(node.id);
  }

  _rebuildPickables() {
    this._pickables = [...this.nodes.values()].map((node) => node.mesh);
  }

  _paintSelection() {
    for (const node of this.nodes.values()) {
      const selected = node.id === this.selectedId;
      const isCenter = node.id === this.orbitCenterId;
      const base = node.role === 'joint' ? JOINT_COLOR : LINK_COLOR;
      let color = base;
      if (isCenter && !selected) color = CENTER_COLOR;
      if (selected) color = emphasizeColor(base);
      node.mesh.material.color.copy(color);
      if (selected) {
        node.mesh.material.emissive.copy(emphasizeEmissive(base));
      } else if (isCenter) {
        node.mesh.material.emissive.copy(emphasizeEmissive(CENTER_COLOR));
      } else {
        node.mesh.material.emissive.copy(ZERO);
      }
      this._applySurfaceStyle(node.mesh.material, node.role);
      node.outline.visible = selected || isCenter;
      if (selected) {
        node.outline.material.color.copy(emphasizeOutline(base));
      } else if (isCenter) {
        node.outline.material.color.copy(emphasizeOutline(CENTER_COLOR));
      } else {
        node.outline.material.color.copy(OUTLINE_COLOR);
      }
      node.mesh.scale.setScalar(node.radius);
    }
  }

  select(id) {
    if (id && !this.nodes.has(id)) return;
    this.selectedId = id ?? null;
    if (this.orbitCenterId && this.orbitCenterId === this.selectedId) {
      this.orbitCenterId = null;
    }
    this._paintSelection();
  }

  setOrbitCenter(id) {
    if (!id || !this.nodes.has(id)) {
      this.orbitCenterId = null;
      this._paintSelection();
      return false;
    }
    const selected = this.getSelected();
    const center = this.nodes.get(id);
    if (!selected || selected.role !== 'joint' || center?.role !== 'joint') return false;
    // Pivot must be the selected joint's parent (roots cannot be the rotating limb).
    if (selected.parentId !== id) return false;
    this.orbitCenterId = id;
    this._paintSelection();
    return true;
  }

  clearOrbitCenter() {
    this.orbitCenterId = null;
    this._paintSelection();
  }

  areAdjacentJoints(aId, bId) {
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (!a || !b || a.role !== 'joint' || b.role !== 'joint') return false;
    return a.parentId === bId || b.parentId === aId;
  }

  /** Joint A and every descendant under A (depth-first). */
  getSubtreeJointIds(rootId) {
    const root = this.nodes.get(rootId);
    if (!root || root.role !== 'joint') return [];
    const ids = [];
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      ids.push(id);
      const node = this.nodes.get(id);
      if (!node?.childIds) continue;
      for (const childId of node.childIds) stack.push(childId);
    }
    return ids;
  }

  /** Reflect a world rotation across the YZ symmetry plane (x → -x). */
  _mirrorRotation(quat, target = _mirrorQuat) {
    const angle = 2 * Math.acos(Math.min(1, Math.max(-1, quat.w)));
    if (angle < 1e-10 || Number.isNaN(angle)) {
      return target.identity();
    }
    _axis.set(quat.x, quat.y, quat.z);
    if (_axis.lengthSq() < 1e-12) return target.identity();
    _axis.normalize();
    _axis.x *= -1;
    return target.setFromAxisAngle(_axis, -angle);
  }

  _applyRotationAroundPoint(jointIds, center, quat) {
    for (const id of jointIds) {
      const node = this.nodes.get(id);
      if (!node || node.role !== 'joint') continue;
      _offset.copy(node.position).sub(center);
      _offset.applyQuaternion(quat);
      node.position.copy(center).add(_offset);
    }
    const touched = new Set();
    for (const id of jointIds) {
      const node = this.nodes.get(id);
      if (!node) continue;
      if (node.parentId) touched.add(this._edgeKey(node.parentId, id));
      for (const childId of node.childIds ?? []) touched.add(this._edgeKey(id, childId));
    }
    for (const key of touched) {
      const edge = this.edges.get(key);
      if (edge) this._rebuildEdgeLinks(edge);
    }
  }

  /**
   * Rotate joint A and its entire descendant subtree around parent pivot B.
   * If A is symmetry-bound, also rotate A' subtree around B' with mirrored rotation.
   * Center–center pairs should pass planar-constrained quaternions from the UI.
   */
  rotateSubtree(jointId, pivotId, quat, { applySymmetry = this.symmetry } = {}) {
    const joint = this.nodes.get(jointId);
    const pivot = this.nodes.get(pivotId);
    if (!joint || !pivot || joint.role !== 'joint' || pivot.role !== 'joint') return false;
    if (joint.parentId !== pivotId) return false;
    if (!quat || Math.abs(quat.w) > 1 + 1e-6) return false;

    const ids = this.getSubtreeJointIds(jointId);
    this._applyRotationAroundPoint(ids, pivot.position.clone(), quat);

    if (applySymmetry && this.isSymmetryBound(joint)) {
      const mirrorJointId = this.getMirrorJointId(joint);
      if (mirrorJointId && mirrorJointId !== jointId) {
        const mirrorPivotId = this.getMirrorJointId(pivot) ?? pivotId;
        const mirrorPivot = this.nodes.get(mirrorPivotId);
        if (mirrorPivot) {
          // Avoid double-applying if mirror joint sits inside the primary subtree.
          const primary = new Set(ids);
          if (!primary.has(mirrorJointId)) {
            const mirrorIds = this.getSubtreeJointIds(mirrorJointId);
            this._applyRotationAroundPoint(
              mirrorIds,
              mirrorPivot.position.clone(),
              this._mirrorRotation(quat, _quat)
            );
          }
        }
      }
    }

    // Keep center joints on the symmetry plane after any numeric drift.
    for (const id of this.getSubtreeJointIds(jointId)) {
      const node = this.nodes.get(id);
      if (node && this.isCenterJoint(node)) node.position.x = 0;
    }
    if (applySymmetry && this.isSymmetryBound(joint)) {
      const mirrorJointId = this.getMirrorJointId(joint);
      if (mirrorJointId && mirrorJointId !== jointId) {
        for (const id of this.getSubtreeJointIds(mirrorJointId)) {
          const node = this.nodes.get(id);
          if (node && this.isCenterJoint(node)) node.position.x = 0;
        }
      }
    }

    this._paintSelection();
    return true;
  }

  /**
   * @deprecated Prefer rotateSubtree with a quaternion from the rotate gizmo.
   */
  orbitSelected(angle, axis, { applySymmetry = this.symmetry } = {}) {
    const selected = this.getSelected();
    const center = this.getOrbitCenter();
    if (!selected || !center) return false;
    if (this.isCenterJoint(selected) && this.isCenterJoint(center)) {
      const n = axis.clone().normalize();
      const signed = angle * n.x;
      if (Math.abs(signed) < 1e-10) return false;
      _quat.setFromAxisAngle(new Vector3(1, 0, 0), signed);
    } else {
      _quat.setFromAxisAngle(axis.clone().normalize(), angle);
    }
    return this.rotateSubtree(selected.id, center.id, _quat, { applySymmetry });
  }

  _clearEdgeLinks(edge) {
    for (const linkId of edge.linkIds ?? []) {
      const link = this.nodes.get(linkId);
      if (link) this._disposeNode(link);
    }
    edge.linkIds = [];
  }

  _rebuildEdgeLinks(edge) {
    const a = this.nodes.get(edge.parentId);
    const b = this.nodes.get(edge.childId);
    if (!a || !b) return;
    const plan = planLinkChain(a.position, a.radius, b.position, b.radius);
    const prev = edge.linkIds ?? [];
    const nextIds = [];
    for (let i = 0; i < plan.samples.length; i += 1) {
      const sample = plan.samples[i];
      let link = prev[i] ? this.nodes.get(prev[i]) : null;
      if (link && link.role === 'link') {
        link.position.copy(sample.position);
        link.radius = sample.radius;
        link.mesh.scale.setScalar(link.radius);
        nextIds.push(link.id);
      } else {
        link = this._registerNode({
          id: uid('link'),
          role: 'link',
          position: sample.position,
          radius: sample.radius,
          edgeKey: edge.key,
          edgeT: sample.t ?? (i + 1) / (plan.samples.length + 1)
        });
        nextIds.push(link.id);
      }
      link.edgeKey = edge.key;
      link.edgeT = sample.t ?? (i + 1) / (plan.samples.length + 1);
    }
    for (let i = plan.samples.length; i < prev.length; i += 1) {
      const leftover = this.nodes.get(prev[i]);
      if (leftover) this._disposeNode(leftover);
    }
    edge.linkIds = nextIds;
    this._rebuildPickables();
  }

  _refreshLinksAround(jointId) {
    for (const edge of this.edges.values()) {
      if (edge.parentId === jointId || edge.childId === jointId) this._rebuildEdgeLinks(edge);
    }
  }

  _wouldCreateCycle(parentId, childId) {
    let cursor = this.nodes.get(parentId);
    while (cursor?.role === 'joint') {
      if (cursor.id === childId) return true;
      cursor = cursor.parentId ? this.nodes.get(cursor.parentId) : null;
    }
    return false;
  }

  _disconnectJoints(parentId, childId) {
    const key = this._edgeKey(parentId, childId);
    const edge = this.edges.get(key);
    if (edge) {
      this._clearEdgeLinks(edge);
      this.edges.delete(key);
    }
    const parent = this.nodes.get(parentId);
    const child = this.nodes.get(childId);
    parent?.childIds?.delete(childId);
    if (child?.parentId === parentId) child.parentId = null;
  }

  connectJoints(parentId, childId) {
    if (parentId === childId) return null;
    const parent = this.nodes.get(parentId);
    const child = this.nodes.get(childId);
    if (!parent || !child || parent.role !== 'joint' || child.role !== 'joint') return null;
    if (this._wouldCreateCycle(parentId, childId)) return null;

    if (child.parentId && child.parentId !== parentId) {
      this._disconnectJoints(child.parentId, childId);
    }
    const key = this._edgeKey(parentId, childId);
    if (this.edges.has(key)) {
      const existing = this.edges.get(key);
      this._rebuildEdgeLinks(existing);
      return existing;
    }
    child.parentId = parentId;
    parent.childIds.add(childId);
    const edge = { key, parentId, childId, linkIds: [] };
    this.edges.set(key, edge);
    this._rebuildEdgeLinks(edge);
    return edge;
  }

  /** Place the first/root joint through the dedicated UI action. Q never calls this. */
  createRootJoint(worldPosition = new Vector3(0, 1, 0), {
    radius = DEFAULT_JOINT_RADIUS
  } = {}) {
    const pos = worldPosition.clone();
    pos.x = 0;
    return this.createJoint(pos, {
      radius,
      parentJointId: null,
      applySymmetry: false,
      asCenter: true
    });
  }

  isCenterJoint(nodeOrId) {
    const node = typeof nodeOrId === 'string' ? this.nodes.get(nodeOrId) : nodeOrId;
    if (!node || node.role !== 'joint') return false;
    return node.centerAxis === true || (node.symmetryBound && node.mirrorOf === node.id);
  }

  /** True when this joint participates in symmetry pairing. */
  isSymmetryBound(nodeOrId) {
    const node = typeof nodeOrId === 'string' ? this.nodes.get(nodeOrId) : nodeOrId;
    if (!node || node.role !== 'joint') return false;
    return node.symmetryBound === true;
  }

  /**
   * Explicit mirror record only — never invents partners by geometry.
   * Returns this id for center joints (mirror-of-self).
   */
  getMirrorJointId(nodeOrId) {
    const node = typeof nodeOrId === 'string' ? this.nodes.get(nodeOrId) : nodeOrId;
    if (!node || node.role !== 'joint' || !node.symmetryBound) return null;
    if (!node.mirrorOf) return null;
    if (node.mirrorOf === node.id) return node.id;
    if (!this.nodes.has(node.mirrorOf)) return null;
    return node.mirrorOf;
  }

  /** @deprecated use getMirrorJointId — kept as alias for call sites. */
  _mirrorJointId(jointId) {
    return this.getMirrorJointId(jointId);
  }

  _markCenterSymmetry(joint) {
    joint.centerAxis = true;
    joint.symmetryBound = true;
    joint.mirrorOf = joint.id;
    joint.position.x = 0;
  }

  _pairSymmetryMirrors(a, b) {
    a.symmetryBound = true;
    b.symmetryBound = true;
    a.centerAxis = false;
    b.centerAxis = false;
    a.mirrorOf = b.id;
    b.mirrorOf = a.id;
  }

  /**
   * Snap a surface hit onto the symmetry plane (x=0) while staying on the parent sphere.
   * Used when creating center-axis children (spine-like).
   */
  projectSurfacePointToCenterPlane(parentJointId, surfacePoint, target = new Vector3()) {
    const parent = this.nodes.get(parentJointId);
    if (!parent || parent.role !== 'joint') return null;
    _dir.copy(surfacePoint).sub(parent.position);
    _dir.x = 0;
    if (_dir.lengthSq() < 1e-12) _dir.set(0, 1, 0);
    _dir.normalize();
    return target.copy(parent.position).addScaledVector(_dir, parent.radius);
  }

  /**
   * Q draw: create a child Joint whose center is exactly the picked point on
   * the parent Joint's surface. Dragging after creation changes radius only.
   */
  extrudeJointFromSurface(parentJointId, surfacePoint, {
    radius = null,
    applySymmetry = this.symmetry
  } = {}) {
    const parent = this.nodes.get(parentJointId);
    if (!parent || parent.role !== 'joint') return null;
    const childRadius = clampRadius(radius == null ? parent.radius : radius);
    const joint = this.createJoint(surfacePoint, {
      radius: childRadius,
      parentJointId,
      applySymmetry
    });
    if (!joint) return null;
    joint._drawParentId = parentJointId;
    return joint;
  }

  /**
   * Center-create mode: one child center joint on a center parent, forced onto
   * the symmetry plane. Never mirrors into a left/right pair.
   */
  extrudeCenterJointFromSurface(parentJointId, surfacePoint, {
    radius = null
  } = {}) {
    const parent = this.nodes.get(parentJointId);
    if (!parent || parent.role !== 'joint') return null;
    if (!this.isCenterJoint(parent)) return null;
    const onPlane = this.projectSurfacePointToCenterPlane(parentJointId, surfacePoint, _pos);
    if (!onPlane) return null;
    const childRadius = clampRadius(radius == null ? parent.radius : radius);
    const joint = this.createJoint(onPlane, {
      radius: childRadius,
      parentJointId,
      applySymmetry: false,
      asCenter: true
    });
    if (!joint) return null;
    joint._drawParentId = parentJointId;
    return joint;
  }

  /**
   * While Q-dragging: update radius only. The press hit point remains the new
   * Joint's position regardless of its changing size.
   */
  updateDraftJoint(jointId, radius, { applySymmetry = this.symmetry } = {}) {
    const joint = this.nodes.get(jointId);
    if (!joint || joint.role !== 'joint') return;
    const nextR = clampRadius(radius);
    joint.radius = nextR;
    joint.mesh.scale.setScalar(nextR);
    this._refreshLinksAround(joint.id);
    if (applySymmetry && this.isSymmetryBound(joint)) {
      const mirrorId = this.getMirrorJointId(joint);
      if (mirrorId && mirrorId !== jointId) {
        const mirror = this.nodes.get(mirrorId);
        if (mirror) {
          mirror.radius = nextR;
          mirror.mesh.scale.setScalar(nextR);
          this._refreshLinksAround(mirror.id);
        }
      }
    }
    this._paintSelection();
  }

  finalizeDraftJoint(jointId) {
    const joint = this.nodes.get(jointId);
    if (!joint) return;
    delete joint._drawParentId;
    this._refreshLinksAround(jointId);
    this._paintSelection();
  }

  createJoint(worldPosition, {
    radius = DEFAULT_JOINT_RADIUS,
    parentJointId = null,
    applySymmetry = this.symmetry,
    asCenter = false
  } = {}) {
    const clamped = clampRadius(radius);
    const pos = worldPosition.clone();
    const parent = parentJointId ? this.nodes.get(parentJointId) : null;

    if (asCenter) {
      if (parentJointId) {
        if (!parent || parent.role !== 'joint' || !this.isCenterJoint(parent)) {
          return null;
        }
      }
      pos.x = 0;
    }

    const onAxis = Math.abs(pos.x) <= SYMMETRY_EPSILON;
    const joint = this._registerNode({
      id: uid('joint'),
      role: 'joint',
      position: pos,
      radius: clamped
    });

    if (parent && parent.role === 'joint') {
      this.connectJoints(parent.id, joint.id);
    }

    // Center joints: always symmetry-bound with mirror record = self.
    if (asCenter) {
      this._markCenterSymmetry(joint);
      this.select(joint.id);
      this._paintSelection();
      return joint;
    }

    // Symmetry create only when the parent already carries the flag + mirror record.
    const parentBound = parent && this.isSymmetryBound(parent);
    const mirrorParentId = parentBound ? this.getMirrorJointId(parent) : null;
    const canMirror = Boolean(applySymmetry && parentBound && mirrorParentId);

    if (canMirror && onAxis) {
      this._markCenterSymmetry(joint);
    } else if (canMirror && !onAxis) {
      const mirrorPos = new Vector3(-pos.x, pos.y, pos.z);
      const mirror = this._registerNode({
        id: uid('joint'),
        role: 'joint',
        position: mirrorPos,
        radius: clamped
      });
      this._pairSymmetryMirrors(joint, mirror);
      this.connectJoints(mirrorParentId, mirror.id);
    }
    // else: asymmetric / unbound parent — symmetryBound stays false, mirrorOf null

    this.select(joint.id);
    this._paintSelection();
    return joint;
  }

  setRadius(nodeId, radius, { applySymmetry = this.symmetry } = {}) {
    const node = this.nodes.get(nodeId);
    if (!node || node.role !== 'joint') return false;
    if (node._drawParentId) {
      this.updateDraftJoint(nodeId, radius, { applySymmetry });
      return true;
    }
    node.radius = clampRadius(radius);
    node.mesh.scale.setScalar(node.radius);
    this._refreshLinksAround(node.id);
    if (applySymmetry && this.isSymmetryBound(node)) {
      const mirrorId = this.getMirrorJointId(node);
      if (mirrorId && mirrorId !== nodeId) {
        const mirror = this.nodes.get(mirrorId);
        if (mirror) {
          mirror.radius = node.radius;
          mirror.mesh.scale.setScalar(mirror.radius);
          this._refreshLinksAround(mirror.id);
        }
      }
    }
    this._paintSelection();
    return true;
  }

  moveJoint(nodeId, worldPosition, { applySymmetry = this.symmetry } = {}) {
    const node = this.nodes.get(nodeId);
    if (!node || node.role !== 'joint') return false;
    const next = worldPosition.clone();
    if (this.isCenterJoint(node)) {
      next.x = 0;
    }
    node.position.copy(next);
    this._refreshLinksAround(nodeId);
    if (applySymmetry && this.isSymmetryBound(node)) {
      const mirrorId = this.getMirrorJointId(node);
      if (mirrorId && mirrorId !== nodeId) {
        const mirror = this.nodes.get(mirrorId);
        if (mirror) {
          mirror.position.set(-next.x, next.y, next.z);
          this._refreshLinksAround(mirrorId);
        }
      }
    }
    return true;
  }

  _edgeContainingLink(linkId) {
    for (const [key, edge] of this.edges) {
      if ((edge.linkIds ?? []).includes(linkId)) return { key, edge };
    }
    return null;
  }

  promoteLinkToJoint(linkId, { applySymmetry = this.symmetry } = {}) {
    const link = this.nodes.get(linkId);
    if (!link || link.role !== 'link') return null;
    const found = this._edgeContainingLink(linkId);
    if (!found) return null;

    const { edge } = found;
    const parentId = edge.parentId;
    const childId = edge.childId;
    const pos = link.position.clone();
    const radius = clampRadius(Math.max(link.radius, DEFAULT_JOINT_RADIUS * 0.85));
    const edgeT = link.edgeT ?? ((edge.linkIds.indexOf(linkId) + 1) / (edge.linkIds.length + 1));

    this._disconnectJoints(parentId, childId);

    const joint = this._registerNode({
      id: uid('joint'),
      role: 'joint',
      position: pos,
      radius
    });
    const parentNode = this.nodes.get(parentId);
    const childNode = this.nodes.get(childId);
    if (
      Math.abs(pos.x) <= SYMMETRY_EPSILON
      && this.isCenterJoint(parentNode)
      && this.isCenterJoint(childNode)
    ) {
      this._markCenterSymmetry(joint);
    }
    this.connectJoints(parentId, joint.id);
    this.connectJoints(joint.id, childId);

    if (
      applySymmetry
      && Math.abs(pos.x) > SYMMETRY_EPSILON
      && this.isSymmetryBound(parentNode)
      && this.isSymmetryBound(childNode)
    ) {
      const mirrorParent = this.getMirrorJointId(parentId);
      const mirrorChild = this.getMirrorJointId(childId);
      if (mirrorParent && mirrorChild && mirrorChild !== childId) {
        const mKey = this._edgeKey(mirrorParent, mirrorChild);
        const mEdge = this.edges.get(mKey);
        if (mEdge?.linkIds?.length) {
          const idx = Math.min(
            Math.max(Math.round(edgeT * (mEdge.linkIds.length + 1) - 1), 0),
            mEdge.linkIds.length - 1
          );
          const mLinkId = mEdge.linkIds[idx];
          const promoted = this.promoteLinkToJoint(mLinkId, { applySymmetry: false });
          if (promoted) {
            this._pairSymmetryMirrors(joint, promoted);
          }
        }
      }
    }

    this.select(joint.id);
    this._paintSelection();
    return joint;
  }

  deleteSelected({ applySymmetry = this.symmetry } = {}) {
    const selected = this.getSelected();
    if (!selected || selected.role !== 'joint') return false;
    const ids = [selected.id];
    if (applySymmetry && this.isSymmetryBound(selected)) {
      const mirrorId = this.getMirrorJointId(selected);
      if (mirrorId && mirrorId !== selected.id) ids.push(mirrorId);
    }
    for (const id of ids) this._deleteJoint(id);
    this.selectedId = null;
    this.orbitCenterId = null;
    this._paintSelection();
    return true;
  }

  _deleteJoint(id) {
    const node = this.nodes.get(id);
    if (!node || node.role !== 'joint') return false;
    const parentId = node.parentId;
    const childIds = [...node.childIds];
    const mirrorId = node.mirrorOf;

    if (parentId) this._disconnectJoints(parentId, id);
    for (const childId of childIds) this._disconnectJoints(id, childId);
    this._disposeNode(node);

    // Delete one Joint, not its whole branch. Preserve the hierarchy by
    // splicing direct children back to the deleted Joint's parent.
    if (parentId && this.nodes.get(parentId)?.role === 'joint') {
      for (const childId of childIds) this.connectJoints(parentId, childId);
    }
    if (mirrorId && mirrorId !== id) {
      const mirror = this.nodes.get(mirrorId);
      if (mirror?.mirrorOf === id) {
        mirror.mirrorOf = null;
        mirror.symmetryBound = false;
      }
    }
    this._rebuildPickables();
    return true;
  }

  update() {
    this._paintSelection();
  }

  dispose() {
    this.clear();
    this.root.removeFromParent();
    this._sphereGeo.dispose();
    this._outlineGeo.dispose();
  }
}

export function hitOnCameraPlane(raycaster, camera, point, target = new Vector3()) {
  camera.getWorldDirection(_normal);
  const plane = new Plane().setFromNormalAndCoplanarPoint(_normal, point);
  if (!raycaster.ray.intersectPlane(plane, target)) return null;
  return target;
}

export function setPointerFromEvent(event, canvas, pointer = new Vector2()) {
  const bounds = canvas.getBoundingClientRect();
  pointer.set(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1
  );
  return pointer;
}

export function pickNode(graph, raycaster) {
  const hits = raycaster.intersectObjects(graph.getPickables(), false);
  const hit = hits[0];
  if (!hit?.object?.userData?.nodeId) return null;
  return graph.nodes.get(hit.object.userData.nodeId) ?? null;
}

/** Pick a joint (or link) and return node + world hit point on the sphere surface. */
export function pickNodeHit(graph, raycaster) {
  const hits = raycaster.intersectObjects(graph.getPickables(), false);
  const hit = hits[0];
  if (!hit?.object?.userData?.nodeId) return null;
  const node = graph.nodes.get(hit.object.userData.nodeId);
  if (!node) return null;
  return { node, point: hit.point.clone(), distance: hit.distance };
}

export {
  DEFAULT_JOINT_RADIUS,
  MIN_RADIUS,
  MAX_RADIUS,
  LINK_SPACING_FACTOR,
  LINK_CLOSE_DIST_FACTOR
};
