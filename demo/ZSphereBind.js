/**
 * Joint graph → Skeleton + envelope auto-weights (preview / GLB export).
 * Link spheres are ignored — only joints + parent edges become bones.
 */
import {
  Bone,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  STATIC_UNCOVERED_BONE_ID,
  geometryToMeshBuffers,
  voxelBindWeights
} from './ZSphereVoxelBind.js';

export { STATIC_UNCOVERED_BONE_ID };

const _a = new Vector3();
const _b = new Vector3();
const _ab = new Vector3();
const _ap = new Vector3();
const _closest = new Vector3();
const _world = new Vector3();
const _invBind = new Matrix4();

/** Soften very tight joint radii so thin limbs still catch nearby verts. */
const ENVELOPE_RADIUS_SCALE = 1.35;
/** Floor tracks editable min sphere — fingers/toes must keep small envelopes. */
const ENVELOPE_RADIUS_FLOOR = 0.003;

/**
 * Pure data: joints only. Links never appear here.
 * @param {{ joints?: Array<object> }} graphState captureState() snapshot
 */
export function skeletonSpecFromGraphState(graphState) {
  const joints = Array.isArray(graphState?.joints) ? graphState.joints : [];
  const idSet = new Set(joints.map((j) => j?.id).filter(Boolean));
  const bones = [];
  for (const joint of joints) {
    if (!joint?.id) continue;
    const parentId = joint.parentId && idSet.has(joint.parentId) ? joint.parentId : null;
    bones.push({
      id: joint.id,
      name: joint.id,
      parentId,
      x: Number(joint.x) || 0,
      y: Number(joint.y) || 0,
      z: Number(joint.z) || 0,
      envelopeRadius: Math.max(ENVELOPE_RADIUS_FLOOR, Number(joint.radius) || ENVELOPE_RADIUS_FLOOR)
    });
  }
  return { version: 1, bones };
}

/**
 * Build a Three.js Bone hierarchy in scene space (identity rotations, local offsets).
 * @returns {{ armature: Group, skeleton: Skeleton, boneMap: Map<string, Bone>, bones: Bone[] }}
 */
export function buildSkeletonFromSpec(spec) {
  const defs = Array.isArray(spec?.bones) ? spec.bones : [];
  if (defs.length === 0) {
    throw new TypeError('SkeletonSpec 至少需要一个关节');
  }
  const byId = new Map();
  for (const def of defs) {
    if (!def?.id) continue;
    byId.set(def.id, def);
  }
  if (byId.size === 0) throw new TypeError('SkeletonSpec 没有有效关节');

  const armature = new Group();
  armature.name = 'Armature';
  const boneMap = new Map();
  const bones = [];

  function ensureBone(id) {
    if (boneMap.has(id)) return boneMap.get(id);
    const def = byId.get(id);
    if (!def) return null;
    const bone = new Bone();
    bone.name = def.name || def.id;
    bone.userData.jointId = def.id;
    bone.userData.envelopeRadius = def.envelopeRadius;
    boneMap.set(id, bone);
    bones.push(bone);

    const parentDef = def.parentId ? byId.get(def.parentId) : null;
    if (parentDef) {
      const parentBone = ensureBone(parentDef.id);
      parentBone.add(bone);
      bone.position.set(def.x - parentDef.x, def.y - parentDef.y, def.z - parentDef.z);
    } else {
      armature.add(bone);
      bone.position.set(def.x, def.y, def.z);
    }
    return bone;
  }

  for (const id of byId.keys()) ensureBone(id);

  // Catch-all bone for verts outside every local capture radius.
  // Never posed — prevents incomplete rigs (legs-only) from dragging hands via hip.
  const staticBone = new Bone();
  staticBone.name = STATIC_UNCOVERED_BONE_ID;
  staticBone.userData.jointId = STATIC_UNCOVERED_BONE_ID;
  staticBone.userData.staticUncovered = true;
  staticBone.userData.envelopeRadius = 0;
  armature.add(staticBone);
  staticBone.position.set(0, 0, 0);
  bones.push(staticBone);
  boneMap.set(STATIC_UNCOVERED_BONE_ID, staticBone);

  armature.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  return { armature, skeleton, boneMap, bones };
}

function distancePointToSegment(point, a, b, outClosest = _closest) {
  _ab.copy(b).sub(a);
  const lenSq = _ab.lengthSq();
  if (lenSq < 1e-14) {
    outClosest.copy(a);
    return { distance: point.distanceTo(a), t: 0 };
  }
  let t = _ap.copy(point).sub(a).dot(_ab) / lenSq;
  t = Math.max(0, Math.min(1, t));
  outClosest.copy(a).addScaledVector(_ab, t);
  return { distance: point.distanceTo(outClosest), t };
}

function envelopeWeight(distance, radius) {
  const r = Math.max(ENVELOPE_RADIUS_FLOOR, radius * ENVELOPE_RADIUS_SCALE);
  if (distance >= r) return 0;
  const u = 1 - distance / r;
  return u * u;
}

/**
 * Apply bromesh-style geodesic voxel weights (prototype JS port).
 * Falls back to Euclidean envelope if the mesh has no usable triangles.
 */
export function applyAutoSkinWeights(geometry, spec, skeleton, options = {}) {
  const position = geometry?.getAttribute?.('position');
  if (!position) throw new TypeError('geometry 需要 position');
  const defs = Array.isArray(spec?.bones) ? spec.bones : [];
  const bones = skeleton?.bones;
  if (!bones?.length || defs.length === 0) {
    throw new TypeError('需要 Skeleton 与 SkeletonSpec');
  }

  const indexById = new Map();
  for (let i = 0; i < bones.length; i += 1) {
    const id = bones[i].userData?.jointId || bones[i].name;
    indexById.set(id, i);
  }

  // Bone list in Skeleton order, with world heads from the joint spec.
  let staticBoneIndex = -1;
  const bindBones = bones.map((bone, index) => {
    const isStatic = Boolean(bone.userData?.staticUncovered)
      || bone.name === STATIC_UNCOVERED_BONE_ID;
    if (isStatic) {
      staticBoneIndex = index;
      return { x: 0, y: 0, z: 0, parent: -1, skip: true };
    }
    const id = bone.userData?.jointId || bone.name;
    const def = defs.find((entry) => entry.id === id);
    let parent = -1;
    if (def?.parentId) {
      const p = indexById.get(def.parentId);
      parent = p === undefined ? -1 : p;
    }
    return {
      x: def?.x ?? 0,
      y: def?.y ?? 0,
      z: def?.z ?? 0,
      parent
    };
  });

  try {
    const buffers = geometryToMeshBuffers(geometry);
    const skin = voxelBindWeights(buffers, bindBones, {
      maxResolution: options.maxResolution ?? 64,
      maxInfluences: 4,
      falloffPower: options.falloffPower ?? 4,
      minWeight: options.minWeight ?? 1e-3,
      staticBoneIndex,
      useSurfaceGate: options.useSurfaceGate === true,
      surfaceReachFactor: options.surfaceReachFactor,
      useVisibilityGate: options.useVisibilityGate !== false,
      visibilitySamples: options.visibilitySamples
    });
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skin.boneIndices, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(skin.boneWeights, 4));
    const uncovered = skin.uncoveredVertices || 0;
    return {
      vertexCount: position.count,
      boneCount: bones.length,
      poseBoneCount: bones.length - (staticBoneIndex >= 0 ? 1 : 0),
      method: 'voxelBind',
      grid: skin.grid,
      captureRadius: skin.captureRadius,
      surfaceGate: skin.surfaceGate,
      visibilityGate: skin.visibilityGate,
      unweightedVertices: uncovered,
      uncoveredVertices: uncovered
    };
  } catch (error) {
    const fallback = applyEnvelopeSkinWeights(geometry, spec, skeleton);
    return {
      ...fallback,
      method: 'envelopeFallback',
      warning: error?.message || String(error)
    };
  }
}

/**
 * Bone-segment + joint-sphere envelope → top-4 normalized skin attributes.
 * Kept as fallback when voxel bind cannot run (e.g. missing indices).
 */
export function applyEnvelopeSkinWeights(geometry, spec, skeleton) {
  const position = geometry?.getAttribute?.('position');
  if (!position) throw new TypeError('geometry 需要 position');
  const defs = Array.isArray(spec?.bones) ? spec.bones : [];
  const bones = skeleton?.bones;
  if (!bones?.length || defs.length === 0) {
    throw new TypeError('需要 Skeleton 与 SkeletonSpec');
  }

  const indexById = new Map();
  for (let i = 0; i < bones.length; i += 1) {
    const id = bones[i].userData?.jointId || bones[i].name;
    indexById.set(id, i);
  }

  const defById = new Map(defs.map((d) => [d.id, d]));
  const segments = [];
  for (const def of defs) {
    if (!def.parentId) continue;
    const parent = defById.get(def.parentId);
    const boneIndex = indexById.get(def.id);
    if (!parent || boneIndex === undefined) continue;
    segments.push({
      boneIndex,
      ax: parent.x, ay: parent.y, az: parent.z,
      bx: def.x, by: def.y, bz: def.z,
      ra: parent.envelopeRadius,
      rb: def.envelopeRadius
    });
  }

  const jointSpheres = defs.map((def) => ({
    boneIndex: indexById.get(def.id),
    x: def.x, y: def.y, z: def.z,
    radius: def.envelopeRadius
  })).filter((entry) => entry.boneIndex !== undefined);

  const skinIndex = new Uint16Array(position.count * 4);
  const skinWeight = new Float32Array(position.count * 4);
  const accum = new Float32Array(bones.length);
  let unweighted = 0;

  for (let vi = 0; vi < position.count; vi += 1) {
    accum.fill(0);
    _world.fromBufferAttribute(position, vi);

    for (const seg of segments) {
      _a.set(seg.ax, seg.ay, seg.az);
      _b.set(seg.bx, seg.by, seg.bz);
      const { distance, t } = distancePointToSegment(_world, _a, _b);
      const radius = seg.ra + (seg.rb - seg.ra) * t;
      const w = envelopeWeight(distance, radius);
      if (w > 0) accum[seg.boneIndex] += w;
    }

    for (const joint of jointSpheres) {
      const d = _world.distanceTo(_a.set(joint.x, joint.y, joint.z));
      const w = envelopeWeight(d, joint.radius);
      if (w > 0) accum[joint.boneIndex] += w;
    }

    const ranked = [];
    for (let bi = 0; bi < bones.length; bi += 1) {
      if (accum[bi] > 0) ranked.push([bi, accum[bi]]);
    }
    ranked.sort((a, b) => b[1] - a[1]);

    if (ranked.length === 0) {
      const staticIdx = bones.findIndex((b) => b.userData?.staticUncovered);
      if (staticIdx >= 0) {
        ranked.push([staticIdx, 1]);
      } else {
        let nearest = 0;
        let nearestDist = Infinity;
        for (const joint of jointSpheres) {
          const d = _world.distanceTo(_a.set(joint.x, joint.y, joint.z));
          if (d < nearestDist) {
            nearestDist = d;
            nearest = joint.boneIndex;
          }
        }
        ranked.push([nearest, 1]);
      }
      unweighted += 1;
    }

    const top = ranked.slice(0, 4);
    const total = top.reduce((sum, entry) => sum + entry[1], 0) || 1;
    const base = vi * 4;
    for (let slot = 0; slot < 4; slot += 1) {
      if (slot < top.length) {
        skinIndex[base + slot] = top[slot][0];
        skinWeight[base + slot] = top[slot][1] / total;
      } else {
        skinIndex[base + slot] = top[0][0];
        skinWeight[base + slot] = 0;
      }
    }
  }

  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
  return {
    vertexCount: position.count,
    boneCount: bones.length,
    segmentCount: segments.length,
    unweightedVertices: unweighted
  };
}

function cloneMaterialForPreview(material) {
  if (!material) return material;
  if (Array.isArray(material)) {
    return material.map((entry) => cloneMaterialForPreview(entry));
  }
  const next = material.clone();
  next.transparent = false;
  next.opacity = 1;
  next.depthWrite = true;
  next.depthTest = true;
  next.needsUpdate = true;
  return next;
}

/**
 * Snapshot-based preview rig: does not mutate the live edit graph or mesh.
 * Mesh vertices are baked into world space to match joint coordinates.
 *
 * @param {{
 *   graphState: object,
 *   meshRoot: import('three').Object3D,
 *   meshes: import('three').Mesh[],
 *   maxResolution?: number,
 *   useVisibilityGate?: boolean
 * }} input
 */
export function createBoundPreview({
  graphState,
  meshRoot,
  meshes,
  maxResolution = 64,
  useVisibilityGate = true
}) {
  if (!meshRoot || !Array.isArray(meshes) || meshes.length === 0) {
    throw new Error('预览需要已导入的人物 Mesh');
  }
  const spec = skeletonSpecFromGraphState(graphState);
  if (spec.bones.length === 0) {
    throw new Error('预览需要至少一个关节球');
  }

  const resolution = Math.max(8, Math.min(160, Math.round(Number(maxResolution) || 64)));

  meshRoot.updateMatrixWorld(true);
  const { armature, skeleton, boneMap, bones } = buildSkeletonFromSpec(spec);

  const container = new Group();
  container.name = 'PreviewRig';
  container.add(armature);

  const skinnedMeshes = [];
  const weightStats = [];

  for (const source of meshes) {
    if (!source?.isMesh || !source.geometry) continue;
    source.updateMatrixWorld(true);
    const geometry = source.geometry.clone();
    geometry.applyMatrix4(source.matrixWorld);
    geometry.computeBoundingBox?.();
    geometry.computeBoundingSphere?.();
    // Keep authored normals (smoothing groups); only fill if missing — same as import.
    if (!geometry.getAttribute('normal') && geometry.computeVertexNormals) {
      geometry.computeVertexNormals();
    }

    const stats = applyAutoSkinWeights(geometry, spec, skeleton, {
      maxResolution: resolution,
      useVisibilityGate
    });
    weightStats.push(stats);

    const skinned = new SkinnedMesh(geometry, cloneMaterialForPreview(source.material));
    skinned.name = (source.name || 'Mesh') + '_skinned';
    skinned.frustumCulled = false;
    skinned.castShadow = true;
    skinned.receiveShadow = true;
    // Bind in world/bind space: mesh at identity, bones already in scene positions.
    skinned.bind(skeleton, _invBind.identity());
    container.add(skinned);
    skinnedMeshes.push(skinned);
  }

  if (skinnedMeshes.length === 0) {
    throw new Error('Mesh 没有可用的 geometry');
  }

  function dispose() {
    for (const mesh of skinnedMeshes) {
      mesh.geometry?.dispose?.();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) mat?.dispose?.();
      mesh.removeFromParent();
    }
    armature.removeFromParent();
    container.removeFromParent();
    skeleton.dispose?.();
  }

  return {
    container,
    armature,
    skeleton,
    boneMap,
    bones,
    skinnedMeshes,
    spec,
    weightStats,
    dispose
  };
}

/**
 * Export preview container (armature + skinned meshes) as binary GLB ArrayBuffer.
 */
export function exportBoundPreviewGlb(container) {
  if (!container) return Promise.reject(new Error('没有可导出的预览内容'));
  container.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      container,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error('GLB 导出未返回二进制'));
      },
      (error) => reject(error),
      { binary: true, onlyVisible: true }
    );
  });
}

export function downloadArrayBuffer(filename, buffer, mime = 'model/gltf-binary') {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
