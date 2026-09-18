import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  DEFAULT_JOINT_RADIUS,
  MAX_RADIUS,
  MIN_RADIUS,
  ZSphereGraph,
  pickNode,
  pickNodeHit,
  setPointerFromEvent
} from './ZSphereGraph.js';
import { ZSphereHistory } from './ZSphereHistory.js';
import {
  SCENE_EXTENSION,
  applyMeshOpacity,
  createSceneDocument,
  deserializeMeshPayload,
  disposeObjectTree,
  downloadJson,
  parseMeshFile,
  parseSceneDocument,
  prepareImportedMeshes,
  serializeMeshRoot
} from './ZSphereSceneIO.js';

const canvas = document.querySelector('#scene-canvas');
const viewport = document.querySelector('#viewport');
const toolModes = document.querySelector('#tool-modes');
const toolStatus = document.querySelector('#tool-status');
const toolHint = document.querySelector('#tool-hint');
const toolDescription = document.querySelector('#tool-description');
const selectedReadout = document.querySelector('#selected-readout');
const orbitReadout = document.querySelector('#orbit-readout');
const symmetryToggle = document.querySelector('#symmetry-toggle');
const centerCreateToggle = document.querySelector('#center-create-toggle');
const xrayToggle = document.querySelector('#xray-toggle');
const jointCountEl = document.querySelector('#joint-count');
const linkCountEl = document.querySelector('#link-count');
const edgeCountEl = document.querySelector('#edge-count');
const toolNameEl = document.querySelector('#tool-name');
const symmetryStateEl = document.querySelector('#symmetry-state');
const meshStateEl = document.querySelector('#mesh-state');
const runtimeLabel = document.querySelector('#runtime-label');
const importMeshBtn = document.querySelector('#import-mesh');
const meshFileInput = document.querySelector('#mesh-file-input');
const meshVisibleToggle = document.querySelector('#mesh-visible-toggle');
const meshOpacityInput = document.querySelector('#mesh-opacity');
const meshOpacityOutput = document.querySelector('#mesh-opacity-output');
const zAlwaysVisibleToggle = document.querySelector('#z-always-visible-toggle');
const meshScaleInput = document.querySelector('#mesh-scale');
const meshScaleOutput = document.querySelector('#mesh-scale-output');
const meshFitHeightBtn = document.querySelector('#mesh-fit-height');
const meshFitHeightInput = document.querySelector('#mesh-fit-height-input');
const meshScaleResetBtn = document.querySelector('#mesh-scale-reset');
const meshFileLabel = document.querySelector('#mesh-file-label');
const removeMeshBtn = document.querySelector('#remove-mesh');
const saveSceneBtn = document.querySelector('#save-scene');
const loadSceneBtn = document.querySelector('#load-scene');
const sceneFileInput = document.querySelector('#scene-file-input');

/** @type {'draw'|'move'|'scale'|'rotate'} */
let tool = 'draw';
let drawing = null;
let scaling = null;
let rotating = null;
let activePointerId = null;
/** R-mode: parent pivot confirmed; rotate gizmo is active. */
let rotateBound = false;
const rotatePivot = new THREE.Object3D();
rotatePivot.name = 'ZSphereRotatePivot';
const lastPivotQuat = new THREE.Quaternion();

/** Pixel drag distance before Q-extend actually creates a joint (below = mis-touch). */
const DRAW_DRAG_THRESHOLD_PX = 10;
/** Double-tap Q window to promote a selected Link (empirical). */
const PROMOTE_DOUBLE_Q_MS = 400;
/** Timestamp of the previous Q key while a Link is selected (0 = none). */
let lastPromoteQAt = 0;

const history = new ZSphereHistory({ limit: 64 });

function pushHistory(label) {
  history.push(label, graph.captureState());
}

function applyRestoredGraph() {
  drawing = null;
  scaling = null;
  rotating = null;
  rotateBound = false;
  resetPromoteQArm();
  if (activePointerId != null && canvas.hasPointerCapture?.(activePointerId)) {
    canvas.releasePointerCapture(activePointerId);
  }
  activePointerId = null;
  controls.enabled = true;
  transform.detach();
  graph.clearOrbitCenter();
  syncGizmo();
  syncReadout();
}

function undoEdit() {
  const label = history.undo(
    () => graph.captureState(),
    (state) => graph.restoreState(state)
  );
  if (!label) {
    runtimeLabel.textContent = '没有可撤销的操作';
    return;
  }
  applyRestoredGraph();
  runtimeLabel.textContent = '已撤销：' + label;
}

function redoEdit() {
  const label = history.redo(
    () => graph.captureState(),
    (state) => graph.restoreState(state)
  );
  if (!label) {
    runtimeLabel.textContent = '没有可重做的操作';
    return;
  }
  applyRestoredGraph();
  runtimeLabel.textContent = '已重做：' + label;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color('#101214');
scene.fog = new THREE.Fog('#101214', 6, 14);

const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
camera.position.set(2.2, 1.35, 3.0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 1.0, 0);
controls.minDistance = 0.35;
controls.maxDistance = 10;

scene.add(rotatePivot);

const transform = new TransformControls(camera, canvas);
transform.setMode('translate');
transform.setSpace('world');
transform.setSize(0.75);
const transformHelper = transform.getHelper();
transformHelper.visible = false;
scene.add(transformHelper);
transform.addEventListener('dragging-changed', (event) => {
  controls.enabled = !event.value;
  if (event.value) {
    if (tool === 'move') {
      pushHistory('移动');
    } else if (tool === 'rotate' && rotateBound) {
      pushHistory('旋转');
    }
  }
});
transform.addEventListener('objectChange', () => {
  if (tool === 'move') {
    const selected = graph.getSelected();
    if (!selected || selected.role !== 'joint') return;
    graph.moveJoint(selected.id, selected.position.clone());
    syncReadout();
    return;
  }
  if (tool === 'rotate' && rotateBound) {
    const selected = graph.getSelected();
    const pivot = graph.getOrbitCenter();
    if (!selected || !pivot) return;
    const delta = new THREE.Quaternion()
      .copy(rotatePivot.quaternion)
      .multiply(lastPivotQuat.clone().invert());
    lastPivotQuat.copy(rotatePivot.quaternion);
    if (Math.abs(delta.w - 1) < 1e-8 && delta.x * delta.x + delta.y * delta.y + delta.z * delta.z < 1e-12) {
      return;
    }
    graph.rotateSubtree(selected.id, pivot.id, delta);
    // Keep gizmo anchored on the (stationary) parent center.
    rotatePivot.position.copy(pivot.position);
    syncReadout();
  }
});

scene.add(new THREE.HemisphereLight('#e6eef4', '#332a24', 1.45));
const key = new THREE.DirectionalLight('#fff2e5', 2.8);
key.position.set(2.4, 4.0, 2.8);
scene.add(key);
scene.add(new THREE.DirectionalLight('#8fb9cf', 1.1).translateX(-3).translateY(2));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(12, 12),
  new THREE.MeshStandardMaterial({ color: '#171a1c', roughness: 0.96, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(12, 48, '#31363a', '#24282b');
grid.position.y = 0.002;
grid.material.transparent = true;
grid.material.opacity = 0.34;
scene.add(grid);

const graph = new ZSphereGraph({ xray: false });
scene.add(graph.root);

/** @type {THREE.Object3D|null} */
let characterMeshRoot = null;
/** @type {THREE.Mesh[]} */
let characterMeshes = [];
let characterMeshFileName = '';

/** Uniform scale applied to the imported character root (unknown source units). */
const MESH_SCALE_MIN = 0.001;
const MESH_SCALE_MAX = 5;
const MESH_FIT_HEIGHT_MIN = 0.05;
const MESH_FIT_HEIGHT_MAX = 100;
/** Default target height (m) shown in the free-entry field. */
const MESH_FIT_HEIGHT_DEFAULT = 1.7;

function clampMeshScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return THREE.MathUtils.clamp(n, MESH_SCALE_MIN, MESH_SCALE_MAX);
}

function clampFitHeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MESH_FIT_HEIGHT_DEFAULT;
  return THREE.MathUtils.clamp(n, MESH_FIT_HEIGHT_MIN, MESH_FIT_HEIGHT_MAX);
}

function readFitTargetHeight() {
  return clampFitHeight(meshFitHeightInput.value);
}

function formatMeshScale(value) {
  const n = clampMeshScale(value);
  if (n < 0.01) return n.toFixed(3) + '×';
  if (n < 1) return n.toFixed(3) + '×';
  return n.toFixed(2) + '×';
}

function getCharacterMeshHeight() {
  if (!characterMeshRoot) return 0;
  characterMeshRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(characterMeshRoot);
  if (box.isEmpty()) return 0;
  return Math.max(0, box.max.y - box.min.y);
}

function syncMeshScaleControl(scale) {
  const next = clampMeshScale(scale);
  // Range inputs cannot express every float; keep attribute in sync for readout.
  meshScaleInput.value = String(next);
  meshScaleOutput.textContent = formatMeshScale(next);
}

function applyCharacterMeshScale(scale, { announce = false } = {}) {
  if (!characterMeshRoot) return;
  const next = clampMeshScale(scale);
  characterMeshRoot.scale.setScalar(next);
  characterMeshRoot.updateMatrixWorld(true);
  syncMeshScaleControl(next);
  syncMeshUi();
  if (announce) {
    const height = getCharacterMeshHeight();
    runtimeLabel.textContent = 'Mesh 缩放 '
      + formatMeshScale(next)
      + (height > 0 ? ' · 当前高度约 ' + height.toFixed(3) + ' m' : '');
  }
}

function fitCharacterMeshHeight(targetHeight = readFitTargetHeight()) {
  if (!characterMeshRoot) return;
  const target = clampFitHeight(targetHeight);
  meshFitHeightInput.value = String(target);
  const currentScale = characterMeshRoot.scale.x || 1;
  const height = getCharacterMeshHeight();
  if (height < 1e-8) {
    runtimeLabel.textContent = '无法测量 Mesh 高度';
    return;
  }
  const nativeHeight = height / currentScale;
  if (nativeHeight < 1e-8) {
    runtimeLabel.textContent = '无法测量 Mesh 高度';
    return;
  }
  applyCharacterMeshScale(target / nativeHeight, { announce: true });
  runtimeLabel.textContent = '已缩放到约 '
    + target.toFixed(2) + ' m 高（原高度 '
    + nativeHeight.toFixed(3) + ' → 现 '
    + getCharacterMeshHeight().toFixed(3) + '）';
}

function refreshCharacterMeshAppearance() {
  if (!characterMeshes.length) return;
  applyMeshOpacity(characterMeshes, Number(meshOpacityInput.value), {
    zAlwaysVisible: zAlwaysVisibleToggle.checked
  });
}

function syncMeshUi() {
  const hasMesh = Boolean(characterMeshRoot);
  meshVisibleToggle.disabled = !hasMesh;
  meshOpacityInput.disabled = !hasMesh;
  zAlwaysVisibleToggle.disabled = !hasMesh;
  meshScaleInput.disabled = !hasMesh;
  meshFitHeightBtn.disabled = !hasMesh;
  meshFitHeightInput.disabled = !hasMesh;
  meshScaleResetBtn.disabled = !hasMesh;
  removeMeshBtn.disabled = !hasMesh;
  if (!hasMesh) {
    meshFileLabel.textContent = '未导入';
    meshStateEl.textContent = '无';
    meshVisibleToggle.checked = true;
    syncMeshScaleControl(1);
    return;
  }
  meshFileLabel.textContent = characterMeshFileName || '已导入';
  const verts = characterMeshes.reduce(
    (sum, mesh) => sum + (mesh.geometry?.getAttribute('position')?.count || 0),
    0
  );
  const height = getCharacterMeshHeight();
  meshStateEl.textContent = verts.toLocaleString() + ' v'
    + (height > 0 ? ' · h≈' + height.toFixed(2) : '');
  meshVisibleToggle.checked = characterMeshRoot.visible;
  syncMeshScaleControl(characterMeshRoot.scale.x || 1);
  const opacity = Number(meshOpacityInput.value);
  meshOpacityOutput.textContent = Math.round(opacity * 100) + '%';
}

function clearCharacterMesh() {
  if (!characterMeshRoot) return;
  disposeObjectTree(characterMeshRoot);
  characterMeshRoot = null;
  characterMeshes = [];
  characterMeshFileName = '';
  syncMeshUi();
}

function setCharacterMesh(root, meshes, fileName) {
  clearCharacterMesh();
  characterMeshRoot = root;
  characterMeshRoot.name = 'CharacterMesh';
  characterMeshes = meshes;
  characterMeshFileName = fileName || 'character';
  scene.add(characterMeshRoot);
  characterMeshRoot.visible = meshVisibleToggle.checked;
  // Keep authoring scale if the loader already set one; otherwise start at 1×.
  if (!Number.isFinite(characterMeshRoot.scale.x) || characterMeshRoot.scale.x <= 0) {
    characterMeshRoot.scale.setScalar(1);
  }
  refreshCharacterMeshAppearance();
  syncMeshUi();
}

async function importCharacterMeshFile(file) {
  if (!file) return;
  runtimeLabel.textContent = '正在导入 Mesh…';
  try {
    const content = await parseMeshFile(file);
    const { meshes, vertexCount } = prepareImportedMeshes(content);
    setCharacterMesh(content, meshes, file.name);
    const nativeHeight = getCharacterMeshHeight();
    runtimeLabel.textContent = '已导入 '
      + file.name + ' · ' + meshes.length + ' 网格 · '
      + vertexCount.toLocaleString() + ' 顶点'
      + (nativeHeight > 0 ? ' · 高度约 ' + nativeHeight.toFixed(3) : '')
      + ' · 可填目标身高后点「缩放到该高度」';
  } catch (error) {
    runtimeLabel.textContent = '导入失败：' + (error?.message || error);
  }
}

async function saveSceneToFile() {
  runtimeLabel.textContent = '正在保存场景…';
  try {
    // Capture graph first so Z-ball state matches what the user sees now.
    const graphState = graph.captureState();
    const jointCount = graphState.joints.length;
    const meshHeightBefore = characterMeshRoot ? getCharacterMeshHeight() : 0;
    const meshScaleBefore = characterMeshRoot ? (characterMeshRoot.scale.x || 1) : 1;

    const mesh = characterMeshRoot
      ? await serializeMeshRoot(characterMeshRoot, { fileName: characterMeshFileName })
      : null;

    // Live mesh must remain at the same authored scale after export.
    if (characterMeshRoot) {
      const liveScale = characterMeshRoot.scale.x || 1;
      if (Math.abs(liveScale - meshScaleBefore) > 1e-8) {
        throw new Error('保存后 Mesh 缩放被意外改动');
      }
    }
    if (mesh?.scaleBaked && mesh.authoredScale) {
      const authored = mesh.authoredScale[0] ?? 1;
      if (Math.abs(authored - meshScaleBefore) > 1e-6) {
        throw new Error('导出 Mesh 未记录当前缩放');
      }
    }

    const doc = createSceneDocument({
      graphState,
      settings: {
        symmetry: symmetryToggle.checked,
        xray: xrayToggle.checked,
        centerCreate: centerCreateToggle.checked,
        meshOpacity: Number(meshOpacityInput.value),
        meshVisible: meshVisibleToggle.checked,
        meshFitTargetHeight: readFitTargetHeight(),
        zAlwaysVisible: zAlwaysVisibleToggle.checked
      },
      mesh
    });
    if (doc.graph.joints.length !== jointCount) {
      throw new Error('保存时 Z 球关节数量不一致');
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadJson('zsphere-scene-' + stamp + SCENE_EXTENSION, doc);
    runtimeLabel.textContent = '场景已保存 · 关节 '
      + jointCount
      + (mesh
        ? ' · Mesh 已按当前缩放烘焙'
          + (meshHeightBefore > 0 ? '（高≈' + meshHeightBefore.toFixed(3) + ' m）' : '')
        : ' · 无 Mesh');
  } catch (error) {
    runtimeLabel.textContent = '保存失败：' + (error?.message || error);
  }
}

async function loadSceneFromFile(file) {
  if (!file) return;
  runtimeLabel.textContent = '正在打开场景…';
  try {
    const text = await file.text();
    const doc = parseSceneDocument(text);
    transform.detach();
    rotateBound = false;
    resetPromoteQArm();
    history.clear();
    clearCharacterMesh();
    graph.restoreState(doc.graph);

    if (doc.settings) {
      symmetryToggle.checked = doc.settings.symmetry !== false;
      graph.setSymmetry(symmetryToggle.checked);
      xrayToggle.checked = Boolean(doc.settings.xray);
      graph.setXRay(xrayToggle.checked);
      centerCreateToggle.checked = Boolean(doc.settings.centerCreate);
      if (typeof doc.settings.meshOpacity === 'number') {
        meshOpacityInput.value = String(doc.settings.meshOpacity);
      }
      if (typeof doc.settings.meshFitTargetHeight === 'number') {
        meshFitHeightInput.value = String(clampFitHeight(doc.settings.meshFitTargetHeight));
      }
      meshVisibleToggle.checked = doc.settings.meshVisible !== false;
      zAlwaysVisibleToggle.checked = doc.settings.zAlwaysVisible !== false;
    }

    if (doc.mesh) {
      const loaded = await deserializeMeshPayload(doc.mesh);
      setCharacterMesh(loaded.root, loaded.meshes, loaded.fileName);
      characterMeshRoot.visible = meshVisibleToggle.checked;
      refreshCharacterMeshAppearance();
    }

    syncGizmo();
    syncReadout();
    syncMeshUi();
    runtimeLabel.textContent = '已打开场景'
      + (doc.mesh ? '（含 Mesh）' : '（仅 Z 球）')
      + ' · ' + (file.name || '');
  } catch (error) {
    runtimeLabel.textContent = '打开失败：' + (error?.message || error);
  }
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function resize() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

function setTool(next) {
  if (drawing) {
    if (drawing.committed && drawing.id) graph.finalizeDraftJoint(drawing.id);
    drawing = null;
  }
  if (activePointerId != null && canvas.hasPointerCapture?.(activePointerId)) {
    canvas.releasePointerCapture(activePointerId);
  }
  activePointerId = null;
  controls.enabled = true;
  tool = next;
  scaling = null;
  rotating = null;
  rotateBound = false;
  resetPromoteQArm();
  if (tool !== 'rotate') graph.clearOrbitCenter();
  toolModes.querySelectorAll('[data-tool]').forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const labels = {
    draw: 'Q · 延伸',
    move: 'W · 移动',
    scale: 'E · 缩放',
    rotate: 'R · 旋转'
  };
  const hints = {
    draw: centerCreateToggle.checked
      ? '创建中心球：开。先点选中心球，再在其上拖动延伸轴上子球；Link 升级请先关此开关。'
      : 'Q：先点选关节球（高亮），再在其上拖动延伸。点选 Link 后短时间连按两次 Q 升级。根球用独立按钮。',
    move: 'W：点击选球，拖 Gizmo 移动。中心球只能在对称平面内移动；侧向球可镜像。',
    scale: 'E：只可点选 Joint；上下拖动缩放半径（无 Gizmo）。Link 尺寸自动适配。',
    rotate: 'R：选有父级的球 A → 自动标出父球 B → 再点 B 绑定 → 在 B 处拖旋转 Gizmo；A 整棵子树绕 B 转。根球只能当枢轴。'
  };
  toolStatus.textContent = labels[tool];
  toolHint.textContent = hints[tool];
  toolNameEl.textContent = tool;
  syncGizmo();
  syncReadout();
}

function syncGizmo() {
  const selected = graph.getSelected();
  if (tool === 'move' && selected?.role === 'joint') {
    transform.setMode('translate');
    transform.attach(selected.mesh);
    transformHelper.visible = true;
    transform.enabled = true;
    const center = graph.isCenterJoint(selected);
    transform.showX = !center;
    transform.showY = true;
    transform.showZ = true;
    return;
  }
  if (tool === 'rotate' && rotateBound && selected?.role === 'joint') {
    const pivot = graph.getOrbitCenter();
    if (pivot) {
      transform.setMode('rotate');
      rotatePivot.position.copy(pivot.position);
      rotatePivot.quaternion.identity();
      lastPivotQuat.identity();
      transform.attach(rotatePivot);
      transformHelper.visible = true;
      transform.enabled = true;
      const planar = graph.isCenterJoint(selected) && graph.isCenterJoint(pivot);
      // Center–center: only rotate in the symmetry plane (around world X).
      if (planar) {
        transform.showX = true;
        transform.showY = false;
        transform.showZ = false;
      } else {
        transform.showX = true;
        transform.showY = true;
        transform.showZ = true;
      }
      return;
    }
  }
  transform.detach();
  transformHelper.visible = false;
  transform.enabled = false;
  transform.showX = true;
  transform.showY = true;
  transform.showZ = true;
}

function syncReadout() {
  const selected = graph.getSelected();
  const center = graph.getOrbitCenter();
  let joints = 0;
  let links = 0;
  for (const node of graph.nodes.values()) {
    if (node.role === 'joint') joints += 1;
    else links += 1;
  }
  jointCountEl.textContent = String(joints);
  linkCountEl.textContent = String(links);
  edgeCountEl.textContent = String(graph.edges.size);
  symmetryStateEl.textContent = graph.symmetry ? '开' : '关';
  syncMeshUi();
  if (!selected) {
    selectedReadout.textContent = '—';
  } else {
    const centerTag = selected.role === 'joint' && graph.isCenterJoint(selected) ? ' · 中心轴' : '';
    selectedReadout.textContent = selected.role + ' · ' + selected.id
      + ' · r=' + selected.radius.toFixed(3)
      + (selected.role === 'joint' ? ' · parent=' + (selected.parentId ?? 'root') : '')
      + centerTag;
  }
  if (tool === 'rotate') {
    if (rotateBound && center) {
      orbitReadout.textContent = '已绑定枢轴：' + center.id + ' · 拖 Gizmo 旋转子树';
    } else if (selected && center) {
      orbitReadout.textContent = '父球枢轴预览：' + center.id + ' · 再点父球确认';
    } else {
      orbitReadout.textContent = '选有父级的球；根球只能作枢轴';
    }
  } else {
    orbitReadout.textContent = 'R：选子球 → 再点父球绑定 → Gizmo 旋转';
  }
}

function resetPromoteQArm() {
  lastPromoteQAt = 0;
}

function tryPromoteSelectedLink() {
  const selected = graph.getSelected();
  if (!selected || selected.role !== 'link') return false;
  if (centerCreateToggle.checked) {
    runtimeLabel.textContent = '创建中心球模式下不升级 Link · 请关掉该开关后再试';
    resetPromoteQArm();
    return true;
  }
  pushHistory('升级 Link');
  graph.promoteLinkToJoint(selected.id);
  resetPromoteQArm();
  syncGizmo();
  syncReadout();
  runtimeLabel.textContent = 'Link 已升级为关节球';
  return true;
}

function beginDraw(event) {
  setPointerFromEvent(event, canvas, pointer);
  raycaster.setFromCamera(pointer, camera);
  const hit = pickNodeHit(graph, raycaster);
  const centerCreate = centerCreateToggle.checked;

  if (hit?.node?.role === 'link') {
    graph.select(hit.node.id);
    resetPromoteQArm();
    syncGizmo();
    syncReadout();
    runtimeLabel.textContent = centerCreate
      ? '已选中 Link · 创建中心球模式下不能升级，请先关开关'
      : '已选中 Link · 短时间内连按两次 Q 升级为关节球';
    return;
  }

  if (hit?.node?.role !== 'joint') {
    runtimeLabel.textContent = 'Q 只从父关节球表面延伸 · 根关节请用左侧独立按钮';
    return;
  }

  const selected = graph.getSelected();
  if (!selected || selected.id !== hit.node.id) {
    // First hit: select only (outline feedback). Extrude on a later gesture.
    graph.select(hit.node.id);
    resetPromoteQArm();
    syncGizmo();
    syncReadout();
    if (centerCreate && !graph.isCenterJoint(hit.node)) {
      runtimeLabel.textContent = '已选中 · 创建中心球需要选中心球后再延伸';
    } else {
      runtimeLabel.textContent = '已选中 · 再在此球上拖动延伸';
    }
    return;
  }

  if (centerCreate && !graph.isCenterJoint(hit.node)) {
    runtimeLabel.textContent = '创建中心球：父级必须是中心球（根或脊柱）';
    return;
  }

  // Already selected — wait until the pointer moves past the drag threshold.
  drawing = {
    committed: false,
    id: null,
    parentId: hit.node.id,
    hitPoint: hit.point.clone(),
    centerCreate,
    startX: event.clientX,
    startY: event.clientY,
    scaleStartY: event.clientY,
    startRadius: Math.min(hit.node.radius, DEFAULT_JOINT_RADIUS)
  };
  activePointerId = event.pointerId;
  canvas.setPointerCapture?.(event.pointerId);
  controls.enabled = false;
  runtimeLabel.textContent = '拖动以确认延伸 · 未拖够松手则取消';
}

function commitDrawGesture(event) {
  if (!drawing || drawing.committed) return false;
  pushHistory('延伸');
  const joint = drawing.centerCreate
    ? graph.extrudeCenterJointFromSurface(drawing.parentId, drawing.hitPoint, {
      radius: drawing.startRadius
    })
    : graph.extrudeJointFromSurface(drawing.parentId, drawing.hitPoint, {
      radius: drawing.startRadius
    });
  if (!joint) {
    history.discardLast();
    drawing = null;
    runtimeLabel.textContent = '无法在此延伸';
    return false;
  }
  drawing.committed = true;
  drawing.id = joint.id;
  drawing.scaleStartY = event.clientY;
  drawing.startRadius = joint.radius;
  syncGizmo();
  syncReadout();
  runtimeLabel.textContent = drawing.centerCreate
    ? '中心球已创建 · 继续拖动调大小 · 松手完成'
    : '已创建 · 继续拖动调大小 · 松手完成';
  return true;
}

function onPointerDown(event) {
  if (event.button !== 0 || transform.axis) return;

  if (tool === 'draw') {
    beginDraw(event);
    return;
  }

  setPointerFromEvent(event, canvas, pointer);
  raycaster.setFromCamera(pointer, camera);
  const picked = pickNode(graph, raycaster);

  if (tool === 'move') {
    if (picked?.role === 'joint') {
      graph.select(picked.id);
      syncGizmo();
      syncReadout();
    } else if (picked?.role === 'link') {
      runtimeLabel.textContent = 'Link 不能移动 · 切换 Q，点选后连按两次 Q 可升级';
    }
    return;
  }

  if (tool === 'scale') {
    if (picked?.role === 'joint') {
      graph.select(picked.id);
      scaling = {
        id: picked.id,
        startY: event.clientY,
        startRadius: picked.radius,
        historyPushed: false
      };
      activePointerId = event.pointerId;
      canvas.setPointerCapture?.(event.pointerId);
      controls.enabled = false;
      syncGizmo();
      syncReadout();
    } else if (picked?.role === 'link') {
      runtimeLabel.textContent = 'Link 尺寸由相邻 Joint 自动生成，不能单独缩放';
    }
    return;
  }

  if (tool === 'rotate') {
    if (!picked || picked.role !== 'joint') {
      if (picked?.role === 'link') runtimeLabel.textContent = 'Link 不能参与旋转绑定';
      return;
    }
    const selected = graph.getSelected();
    const previewPivot = graph.getOrbitCenter();

    // Second click on the highlighted parent confirms the pivot and shows the gizmo.
    if (
      selected?.role === 'joint'
      && selected.parentId === picked.id
      && previewPivot?.id === picked.id
      && !rotateBound
    ) {
      rotateBound = true;
      syncGizmo();
      syncReadout();
      runtimeLabel.textContent = '已绑定父球枢轴 · 拖动旋转 Gizmo';
      return;
    }

    if (!picked.parentId) {
      rotateBound = false;
      graph.select(picked.id);
      graph.clearOrbitCenter();
      syncGizmo();
      syncReadout();
      runtimeLabel.textContent = '根球只能作旋转中心 · 请改选有父级的球';
      return;
    }

    rotateBound = false;
    graph.select(picked.id);
    graph.setOrbitCenter(picked.parentId);
    syncGizmo();
    syncReadout();
    runtimeLabel.textContent = '已选子球 · 再点父球确认枢轴';
    return;
  }
}

function onPointerMove(event) {
  if (drawing) {
    if (!drawing.committed) {
      const dx = event.clientX - drawing.startX;
      const dy = event.clientY - drawing.startY;
      if (Math.hypot(dx, dy) < DRAW_DRAG_THRESHOLD_PX) return;
      if (!commitDrawGesture(event)) return;
    }
    const delta = drawing.scaleStartY - event.clientY;
    const next = drawing.startRadius * (1 + delta * 0.012);
    graph.updateDraftJoint(drawing.id, THREE.MathUtils.clamp(next, MIN_RADIUS, MAX_RADIUS));
    syncReadout();
    return;
  }
  if (scaling) {
    const delta = scaling.startY - event.clientY;
    const next = scaling.startRadius * (1 + delta * 0.012);
    const clamped = THREE.MathUtils.clamp(next, MIN_RADIUS, MAX_RADIUS);
    if (!scaling.historyPushed && Math.abs(clamped - scaling.startRadius) > 1e-6) {
      pushHistory('缩放');
      scaling.historyPushed = true;
    }
    graph.setRadius(scaling.id, clamped);
    syncReadout();
  }
}

function onPointerUp(event) {
  if (drawing) {
    if (drawing.committed && drawing.id) {
      graph.finalizeDraftJoint(drawing.id);
      runtimeLabel.textContent = '关节球已创建';
      syncGizmo();
      syncReadout();
    } else {
      runtimeLabel.textContent = '未拖动足够距离 · 已取消延伸';
    }
  }
  drawing = null;
  scaling = null;
  rotating = null;
  if (activePointerId != null && canvas.hasPointerCapture?.(activePointerId)) {
    canvas.releasePointerCapture(activePointerId);
  }
  activePointerId = null;
  if (!transform.dragging) controls.enabled = true;
}

toolModes.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tool]');
  if (button) setTool(button.dataset.tool);
});

symmetryToggle.addEventListener('change', () => {
  graph.setSymmetry(symmetryToggle.checked);
  syncReadout();
});

centerCreateToggle.addEventListener('change', () => {
  if (tool === 'draw') setTool('draw');
  else syncReadout();
  runtimeLabel.textContent = centerCreateToggle.checked
    ? '已开启创建中心球 · Q 点中心球延伸轴上子球'
    : '已关闭创建中心球 · Q 恢复普通对称延伸';
});

xrayToggle.addEventListener('change', () => {
  graph.setXRay(xrayToggle.checked);
});

document.querySelector('#create-root').addEventListener('click', () => {
  const hasJoint = [...graph.nodes.values()].some((node) => node.role === 'joint');
  if (hasJoint) {
    runtimeLabel.textContent = '已有关节球 · 用 Q 在球面上落点延伸';
    return;
  }
  pushHistory('放置根球');
  graph.createRootJoint(new THREE.Vector3(0, 1.0, 0), { radius: DEFAULT_JOINT_RADIUS });
  syncGizmo();
  syncReadout();
  runtimeLabel.textContent = '已放置根关节球 · Q 点球面落点延伸';
});

document.querySelector('#clear-graph').addEventListener('click', () => {
  const hasAny = graph.nodes.size > 0;
  if (hasAny) pushHistory('清空');
  transform.detach();
  rotateBound = false;
  resetPromoteQArm();
  graph.clear();
  syncGizmo();
  syncReadout();
  runtimeLabel.textContent = '已清空 · 用「放置根关节球」开始';
});

document.querySelector('#delete-selected').addEventListener('click', () => {
  const selected = graph.getSelected();
  if (!selected || selected.role !== 'joint') return;
  pushHistory('删除');
  graph.deleteSelected();
  syncGizmo();
  syncReadout();
});

document.querySelector('#view-front').addEventListener('click', () => {
  camera.position.set(0, 1.2, 3.2);
  controls.target.set(0, 1.0, 0);
  controls.update();
});
document.querySelector('#view-side').addEventListener('click', () => {
  camera.position.set(3.2, 1.2, 0);
  controls.target.set(0, 1.0, 0);
  controls.update();
});
document.querySelector('#view-reset').addEventListener('click', () => {
  camera.position.set(2.2, 1.35, 3.0);
  controls.target.set(0, 1.0, 0);
  controls.update();
});

importMeshBtn.addEventListener('click', () => meshFileInput.click());
meshFileInput.addEventListener('change', async () => {
  const [file] = meshFileInput.files;
  meshFileInput.value = '';
  if (file) await importCharacterMeshFile(file);
});
meshVisibleToggle.addEventListener('change', () => {
  if (!characterMeshRoot) return;
  characterMeshRoot.visible = meshVisibleToggle.checked;
  syncMeshUi();
});
meshOpacityInput.addEventListener('input', () => {
  refreshCharacterMeshAppearance();
  syncMeshUi();
});
zAlwaysVisibleToggle.addEventListener('change', () => {
  refreshCharacterMeshAppearance();
  runtimeLabel.textContent = zAlwaysVisibleToggle.checked
    ? 'Z 球总可见：Mesh 不遮挡 Z 球（球与球仍互挡）'
    : '正常遮挡：Mesh 按深度挡住 Z 球';
});
meshScaleInput.addEventListener('input', () => {
  applyCharacterMeshScale(meshScaleInput.value, { announce: true });
});
meshFitHeightBtn.addEventListener('click', () => {
  fitCharacterMeshHeight(readFitTargetHeight());
});
meshFitHeightInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || meshFitHeightInput.disabled) return;
  event.preventDefault();
  fitCharacterMeshHeight(readFitTargetHeight());
});
meshScaleResetBtn.addEventListener('click', () => {
  applyCharacterMeshScale(1, { announce: true });
});
removeMeshBtn.addEventListener('click', () => {
  clearCharacterMesh();
  runtimeLabel.textContent = '已移除人物 Mesh';
});
saveSceneBtn.addEventListener('click', () => {
  void saveSceneToFile();
});
loadSceneBtn.addEventListener('click', () => sceneFileInput.click());
sceneFileInput.addEventListener('change', async () => {
  const [file] = sceneFileInput.files;
  sceneFileInput.value = '';
  if (file) await loadSceneFromFile(file);
});

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);
window.addEventListener('blur', onPointerUp);

window.addEventListener('keydown', (event) => {
  const tag = event.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
  if (event.defaultPrevented || event.repeat) return;

  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;

  if (mod && !event.altKey && key === 'z') {
    event.preventDefault();
    if (event.shiftKey) redoEdit();
    else undoEdit();
    return;
  }
  if (mod && !event.altKey && key === 'y') {
    event.preventDefault();
    redoEdit();
    return;
  }
  if (mod && !event.altKey && key === 's') {
    event.preventDefault();
    void saveSceneToFile();
    return;
  }
  if (mod && !event.altKey && key === 'o') {
    event.preventDefault();
    sceneFileInput.click();
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (key === 'q') {
    event.preventDefault();
    const selected = graph.getSelected();
    const now = performance.now();
    // Already in Q + Link selected: double-tap Q within the window to promote.
    if (tool === 'draw' && selected?.role === 'link') {
      if (lastPromoteQAt > 0 && now - lastPromoteQAt <= PROMOTE_DOUBLE_Q_MS) {
        tryPromoteSelectedLink();
        return;
      }
      lastPromoteQAt = now;
      runtimeLabel.textContent = centerCreateToggle.checked
        ? '已选中 Link · 创建中心球模式下不能升级，请先关开关'
        : '再按一次 Q（' + PROMOTE_DOUBLE_Q_MS + 'ms 内）升级为关节球';
      return;
    }
    resetPromoteQArm();
    setTool('draw');
  }
  else if (key === 'w') { event.preventDefault(); resetPromoteQArm(); setTool('move'); }
  else if (key === 'e') { event.preventDefault(); resetPromoteQArm(); setTool('scale'); }
  else if (key === 'r') { event.preventDefault(); resetPromoteQArm(); setTool('rotate'); }
  else if (key === 'x') {
    event.preventDefault();
    xrayToggle.checked = !xrayToggle.checked;
    graph.setXRay(xrayToggle.checked);
  } else if (key === 'v') {
    event.preventDefault();
    if (!characterMeshRoot) {
      runtimeLabel.textContent = '请先导入人物 Mesh，再切换 Z 球总可见';
      return;
    }
    zAlwaysVisibleToggle.checked = !zAlwaysVisibleToggle.checked;
    refreshCharacterMeshAppearance();
    runtimeLabel.textContent = zAlwaysVisibleToggle.checked
      ? 'Z 球总可见：Mesh 不遮挡 Z 球（球与球仍互挡）'
      : '正常遮挡：Mesh 按深度挡住 Z 球';
  } else if (key === 'delete' || key === 'backspace') {
    event.preventDefault();
    resetPromoteQArm();
    const selected = graph.getSelected();
    if (!selected || selected.role !== 'joint') return;
    pushHistory('删除');
    graph.deleteSelected();
    syncGizmo();
    syncReadout();
  }
});

function frame() {
  graph.update();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

setTool('draw');
syncReadout();
syncMeshUi();
runtimeLabel.textContent = '可导入人物 Mesh；编 Z 球后 Ctrl+S 保存场景';
toolDescription.textContent = '导入 Mesh 对齐编骨。Q：先点选再延伸；场景保存为 .zscene.json（Z 球 + Mesh）。';
frame();
