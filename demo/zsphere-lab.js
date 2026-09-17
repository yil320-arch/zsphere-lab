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
const runtimeLabel = document.querySelector('#runtime-label');

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
  const joint = drawing.centerCreate
    ? graph.extrudeCenterJointFromSurface(drawing.parentId, drawing.hitPoint, {
      radius: drawing.startRadius
    })
    : graph.extrudeJointFromSurface(drawing.parentId, drawing.hitPoint, {
      radius: drawing.startRadius
    });
  if (!joint) {
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
        startRadius: picked.radius
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
    graph.setRadius(scaling.id, THREE.MathUtils.clamp(next, MIN_RADIUS, MAX_RADIUS));
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
  graph.createRootJoint(new THREE.Vector3(0, 1.0, 0), { radius: DEFAULT_JOINT_RADIUS });
  syncGizmo();
  syncReadout();
  runtimeLabel.textContent = '已放置根关节球 · Q 点球面落点延伸';
});

document.querySelector('#clear-graph').addEventListener('click', () => {
  transform.detach();
  rotateBound = false;
  resetPromoteQArm();
  graph.clear();
  syncGizmo();
  syncReadout();
  runtimeLabel.textContent = '已清空 · 用「放置根关节球」开始';
});

document.querySelector('#delete-selected').addEventListener('click', () => {
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

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);
window.addEventListener('blur', onPointerUp);

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const tag = event.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
  const key = event.key.toLowerCase();
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
  } else if (key === 'delete' || key === 'backspace') {
    event.preventDefault();
    resetPromoteQArm();
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
runtimeLabel.textContent = '根关节用独立按钮；Q 先点选再拖动延伸；Link 点选后连按两次 Q 升级';
toolDescription.textContent = '根 Joint 用独立按钮。Q：先点选父球再拖动延伸；点选 Link 后短时间连按两次 Q 升级。';
frame();
