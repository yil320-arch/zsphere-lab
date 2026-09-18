import { Box3 } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

export const SCENE_FORMAT = 'human-rig-zscene';
export const SCENE_VERSION = 1;
export const SCENE_EXTENSION = '.zscene.json';

/**
 * Lab scene document: ZSphere graph snapshot + optional character mesh (embedded glTF JSON).
 * Link spheres are regenerated from the graph on restore — not stored separately.
 */
export function createSceneDocument({ graphState, settings = {}, mesh = null }) {
  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    savedAt: new Date().toISOString(),
    settings: {
      symmetry: settings.symmetry !== false,
      xray: Boolean(settings.xray),
      centerCreate: Boolean(settings.centerCreate),
      meshOpacity: typeof settings.meshOpacity === 'number' ? settings.meshOpacity : 0.45,
      meshVisible: settings.meshVisible !== false,
      meshFitTargetHeight: typeof settings.meshFitTargetHeight === 'number'
        ? settings.meshFitTargetHeight
        : 1.7,
      /** When true, character mesh does not occlude Z-spheres (edit convenience). */
      zAlwaysVisible: settings.zAlwaysVisible !== false
    },
    graph: graphState ?? { version: 1, nextId: 1, selectedId: null, joints: [] },
    mesh
  };
}

export function parseSceneDocument(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || data.format !== SCENE_FORMAT) {
    throw new Error('不是 human-rig-zscene 场景文件');
  }
  if (Number(data.version) > SCENE_VERSION) {
    throw new Error('场景文件版本过高，请升级 Lab');
  }
  if (!data.graph || !Array.isArray(data.graph.joints)) {
    throw new Error('场景缺少有效的 Z 球图数据');
  }
  return data;
}

export async function parseMeshFile(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'obj') {
    return new OBJLoader().parse(await file.text());
  }
  if (extension === 'glb' || extension === 'gltf') {
    const loader = new GLTFLoader();
    const source = extension === 'gltf' ? await file.text() : await file.arrayBuffer();
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(source, '', resolve, reject);
    });
    return gltf.scene;
  }
  throw new Error('仅支持 GLB、内嵌资源的 GLTF 或 OBJ');
}

/** Collect Mesh objects and clone materials so opacity tweaks stay local. */
export function prepareImportedMeshes(root) {
  const meshes = [];
  let vertexCount = 0;
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry?.getAttribute('position')) return;
    object.geometry = object.geometry.clone();
    if (!object.geometry.getAttribute('normal') && object.geometry.computeVertexNormals) {
      object.geometry.computeVertexNormals();
    }
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => material.clone())
      : object.material?.clone?.() ?? object.material;
    object.castShadow = true;
    object.receiveShadow = true;
    meshes.push(object);
    vertexCount += object.geometry.getAttribute('position').count;
  });
  if (meshes.length === 0) throw new Error('文件中没有可用的 Mesh geometry');
  return { meshes, vertexCount };
}

/**
 * @param {import('three').Mesh[]} meshes
 * @param {number} opacity
 * @param {{ zAlwaysVisible?: boolean }} [options]
 *   zAlwaysVisible: Mesh does not write depth, so Z-spheres stay visible through it.
 *   Z-sphere↔Z-sphere occlusion is unchanged (their own depthTest stays on).
 */
export function applyMeshOpacity(meshes, opacity, { zAlwaysVisible = true } = {}) {
  const o = Math.min(1, Math.max(0.05, Number(opacity) || 1));
  for (const mesh of meshes) {
    mesh.renderOrder = 0;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      material.transparent = o < 0.999;
      material.opacity = o;
      // Always-visible: mesh must not occlude Z-spheres.
      // Normal occlusion: mesh writes depth even when translucent.
      material.depthWrite = zAlwaysVisible ? false : true;
      material.depthTest = true;
      material.needsUpdate = true;
    }
  }
}

export function disposeObjectTree(root) {
  if (!root) return;
  root.traverse((object) => {
    if (object.geometry) object.geometry.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const key of Object.keys(material)) {
        const value = material[key];
        if (value && value.isTexture) value.dispose?.();
      }
      material.dispose?.();
    }
  });
  root.removeFromParent();
}

/**
 * Bake current world transforms into mesh geometries so exported vertices
 * match the on-screen (already scaled) character size.
 */
export function bakeWorldTransformsIntoMeshes(root) {
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    object.geometry = object.geometry.clone();
    object.geometry.applyMatrix4(object.matrixWorld);
    object.geometry.computeBoundingBox?.();
    object.geometry.computeBoundingSphere?.();
    object.position.set(0, 0, 0);
    object.rotation.set(0, 0, 0);
    object.quaternion.identity();
    object.scale.set(1, 1, 1);
    object.updateMatrix();
  });
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
}

/**
 * Embed the live mesh at its current authored size (scale baked into geometry).
 * Payload root TRS is identity so load does not double-apply transforms.
 * @param {import('three').Object3D} meshRoot
 * @param {{ fileName?: string }} [meta]
 */
export async function serializeMeshRoot(meshRoot, meta = {}) {
  if (!meshRoot) return null;
  meshRoot.updateMatrixWorld(true);
  const position = meshRoot.position.toArray();
  const quaternion = meshRoot.quaternion.toArray();
  const scale = meshRoot.scale.toArray();
  const bounds = new Box3().setFromObject(meshRoot);
  const authoredHeight = bounds.isEmpty() ? 0 : Math.max(0, bounds.max.y - bounds.min.y);

  const clone = meshRoot.clone(true);
  clone.traverse((object) => {
    if (object.isMesh && object.geometry) {
      object.geometry = object.geometry.clone();
    }
  });
  // Match live TRS, then bake so embedded glTF vertices equal on-screen size.
  clone.position.fromArray(position);
  clone.quaternion.fromArray(quaternion);
  clone.scale.fromArray(scale);
  bakeWorldTransformsIntoMeshes(clone);

  try {
    const exporter = new GLTFExporter();
    const gltf = await new Promise((resolve, reject) => {
      exporter.parse(
        clone,
        (result) => resolve(result),
        (error) => reject(error),
        { binary: false, onlyVisible: true }
      );
    });
    return {
      fileName: meta.fileName || 'character.gltf',
      // World transforms are baked into geometry — load at identity to avoid double TRS.
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      authoredScale: scale,
      authoredHeight,
      scaleBaked: true,
      gltf
    };
  } finally {
    clone.traverse((object) => {
      object.geometry?.dispose?.();
    });
  }
}

/**
 * @param {object} meshPayload
 * @returns {Promise<{ root: import('three').Object3D, meshes: import('three').Mesh[], vertexCount: number, fileName: string }>}
 */
export async function deserializeMeshPayload(meshPayload) {
  if (!meshPayload?.gltf) throw new Error('场景 mesh 数据缺失');
  const loader = new GLTFLoader();
  const text = typeof meshPayload.gltf === 'string'
    ? meshPayload.gltf
    : JSON.stringify(meshPayload.gltf);
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(text, '', resolve, reject);
  });
  const content = gltf.scene;
  const { meshes, vertexCount } = prepareImportedMeshes(content);
  content.position.fromArray(meshPayload.position || [0, 0, 0]);
  content.quaternion.fromArray(meshPayload.quaternion || [0, 0, 0, 1]);
  content.scale.fromArray(meshPayload.scale || [1, 1, 1]);
  return {
    root: content,
    meshes,
    vertexCount,
    fileName: meshPayload.fileName || 'character.gltf'
  };
}

export function downloadJson(filename, data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.json') ? filename : filename + SCENE_EXTENSION;
  anchor.click();
  URL.revokeObjectURL(url);
}
