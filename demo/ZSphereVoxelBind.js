/**
 * Geodesic voxel skin binding — JS port of bromesh `voxelBindWeights`
 * (Dionne & de Lasa–style, from bromesh/src/rigging/voxel_bind.cpp).
 *
 * Soft Pinocchio / Bone Glow visibility (default): after volume weights, scale
 * each bone's influence by how much of vertex→bone-segment samples stay inside
 * the solid voxel volume. Paths that leave then re-enter (air-gap between legs)
 * are crushed — without hard mesh-graph cuts that tore character meshes.
 *
 * Incomplete skeletons (e.g. legs only): vertices that never receive a local
 * influence are bound to `staticBoneIndex` instead of the nearest hip/root.
 */

export const STATIC_UNCOVERED_BONE_ID = '__uncovered__';

const INF = 0xffff;

/**
 * @typedef {{
 *   maxResolution?: number,
 *   maxInfluences?: number,
 *   falloffPower?: number,
 *   minWeight?: number,
 *   useSurfaceGate?: boolean,
 *   surfaceReachFactor?: number,
 *   useVisibilityGate?: boolean,
 *   visibilitySamples?: number,
 * }} VoxelBindOptions
 */

/**
 * @param {{ positions: Float32Array|number[], indices: Uint32Array|number[] }} mesh
 * @param {{ x: number, y: number, z: number, parent: number, skip?: boolean }[]} bones
 *   parent = index into bones, or -1 for root. Order must match Three Skeleton.
 *   Bones with skip=true (e.g. static uncovered) are not influence sources.
 * @param {VoxelBindOptions & { staticBoneIndex?: number }} [opts]
 */
export function voxelBindWeights(mesh, bones, opts = {}) {
  const maxResolution = Math.max(8, opts.maxResolution ?? 64);
  const K = Math.max(1, opts.maxInfluences ?? 4);
  const falloffPower = opts.falloffPower ?? 4;
  const minWeight = opts.minWeight ?? 1e-3;
  const staticBoneIndex = Number.isInteger(opts.staticBoneIndex) ? opts.staticBoneIndex : -1;
  const useSurfaceGate = opts.useSurfaceGate === true;
  const surfaceReachFactor = opts.surfaceReachFactor ?? 2.0;
  // Soft Pinocchio / Bone Glow: default ON. Hard surface-graph gate stays opt-in.
  const useVisibilityGate = opts.useVisibilityGate !== false;
  const visibilitySamples = Math.max(3, Math.min(9, (opts.visibilitySamples ?? 5) | 0));

  const positions = mesh.positions;
  const indices = mesh.indices;
  const nVerts = (positions.length / 3) | 0;
  const nBones = bones.length;
  if (nVerts === 0 || nBones === 0) {
    throw new TypeError('voxelBind 需要 mesh 顶点与骨骼');
  }
  if (!indices || indices.length < 3) {
    throw new TypeError('voxelBind 需要三角索引（封闭/准封闭 mesh）');
  }

  const grid = makeGrid(positions, maxResolution);
  if (!grid.solid.length) throw new Error('无法建立体素网格');
  rasterizeSurface(positions, indices, grid);
  fillInterior(grid);

  const V = grid.solid.length;
  const headW = bones.map((b) => [b.x, b.y, b.z]);
  const parentSegLen = new Float32Array(nBones);
  for (let i = 0; i < nBones; i += 1) {
    if (bones[i].skip) continue;
    const p = bones[i].parent;
    if (p >= 0 && !bones[p]?.skip) {
      parentSegLen[i] = Math.hypot(
        headW[i][0] - headW[p][0],
        headW[i][1] - headW[p][1],
        headW[i][2] - headW[p][2]
      );
    }
  }

  /** @type {number[][][]} */
  const tailsW = Array.from({ length: nBones }, () => []);
  const segLengths = [];
  for (let i = 0; i < nBones; i += 1) {
    if (bones[i].skip) continue;
    for (let j = 0; j < nBones; j += 1) {
      if (bones[j].skip) continue;
      if (bones[j].parent === i) {
        tailsW[i].push(headW[j]);
        segLengths.push(Math.hypot(
          headW[j][0] - headW[i][0],
          headW[j][1] - headW[i][1],
          headW[j][2] - headW[i][2]
        ));
      }
    }
    if (tailsW[i].length === 0) {
      const p = bones[i].parent;
      let y = [0, 1, 0];
      if (p >= 0 && !bones[p]?.skip) {
        y = [
          headW[i][0] - headW[p][0],
          headW[i][1] - headW[p][1],
          headW[i][2] - headW[p][2]
        ];
        const len = Math.hypot(y[0], y[1], y[2]) || 1;
        y[0] /= len; y[1] /= len; y[2] /= len;
      }
      const leafLen = parentSegLen[i] > 0 ? parentSegLen[i] : grid.cell * 4;
      tailsW[i].push([
        headW[i][0] + y[0] * leafLen,
        headW[i][1] + y[1] * leafLen,
        headW[i][2] + y[2] * leafLen
      ]);
      segLengths.push(leafLen);
    }
  }

  segLengths.sort((a, b) => a - b);
  const medianSeg = segLengths.length
    ? segLengths[(segLengths.length / 2) | 0]
    : grid.cell * 4;
  // Local capture: Euclidean gate so torso geodesic leaks cannot claim a hand
  // when only leg bones exist. ~1.15× median bone length.
  const captureRadius = Math.max(medianSeg * 1.15, grid.cell * 3, 0.06);
  const captureRadiusSq = captureRadius * captureRadius;

  const topW = new Float32Array(V * K);
  const topB = new Int32Array(V * K).fill(-1);
  const reachFactor = 1.25;
  // Tighter than bromesh default 0.12 — limits hip→torso→arm flood on coarse grids.
  const maxAbsReachCells = Math.max(grid.sx, grid.sy, grid.sz) * 0.08;
  const eps = 1e-6;

  const boneDist = new Uint16Array(V);
  const segDist = new Uint16Array(V);

  for (let b = 0; b < nBones; b += 1) {
    if (bones[b].skip) continue;
    boneDist.fill(INF);
    let anySeg = false;
    for (const tail of tailsW[b]) {
      const seeds = seedVoxels(grid, headW[b], tail);
      if (!seeds.length) continue;
      let segLen = Math.hypot(
        tail[0] - headW[b][0],
        tail[1] - headW[b][1],
        tail[2] - headW[b][2]
      );
      if (segLen < grid.cell) segLen = grid.cell;
      const reachCells = Math.min(reachFactor * segLen / grid.cell, maxAbsReachCells);
      const cap = Math.max(6, reachCells | 0);
      bfsFromSeeds(grid, seeds, segDist, cap);
      for (let v = 0; v < V; v += 1) {
        if (segDist[v] < boneDist[v]) boneDist[v] = segDist[v];
      }
      anySeg = true;
    }
    if (!anySeg) continue;

    for (let v = 0; v < V; v += 1) {
      if (!grid.solid[v] || boneDist[v] === INF) continue;
      const w = 1 / (Math.pow(boneDist[v] + 1, falloffPower) + eps);
      if (w < minWeight) continue;
      insertTopK(topW, topB, v * K, K, w, b);
    }
  }

  for (let v = 0; v < V; v += 1) {
    if (!grid.solid[v]) continue;
    let sum = 0;
    for (let k = 0; k < K; k += 1) sum += topW[v * K + k];
    if (sum > 0) {
      const inv = 1 / sum;
      for (let k = 0; k < K; k += 1) topW[v * K + k] *= inv;
    }
  }

  const boneWeights = new Float32Array(nVerts * K);
  const boneIndices = new Uint16Array(nVerts * K);
  const acc = new Float32Array(nBones);
  let uncoveredVertices = 0;

  function distToBoneSq(px, py, pz, boneIndex) {
    let best = Infinity;
    const head = headW[boneIndex];
    const dHead = (head[0] - px) ** 2 + (head[1] - py) ** 2 + (head[2] - pz) ** 2;
    if (dHead < best) best = dHead;
    for (const tail of tailsW[boneIndex]) {
      const dSeg = distPointSegmentSq(px, py, pz, head, tail);
      if (dSeg < best) best = dSeg;
    }
    return best;
  }

  /**
   * Surface reachability: volume voxels may connect through crotch/armpit interior,
   * but influence is kept only if the vertex is within surfaceReachFactor × bone
   * length along the mesh graph (around creases, not through the fold).
   * @type {Uint8Array|null}
   */
  let surfaceMask = null;
  if (useSurfaceGate) {
    surfaceMask = new Uint8Array(nBones * nVerts);
    const adj = buildMeshAdjacency(indices, nVerts);
    for (let b = 0; b < nBones; b += 1) {
      if (bones[b].skip) continue;
      let maxSeg = parentSegLen[b] > 0 ? parentSegLen[b] : medianSeg;
      for (const tail of tailsW[b]) {
        const len = Math.hypot(
          tail[0] - headW[b][0],
          tail[1] - headW[b][1],
          tail[2] - headW[b][2]
        );
        if (len > maxSeg) maxSeg = len;
      }
      const maxSurf = Math.max(maxSeg * surfaceReachFactor, medianSeg * 1.25, grid.cell * 8);
      const seedR = Math.max(maxSeg * 0.45, grid.cell * 2.5, 0.04);
      const seedRSq = seedR * seedR;
      const seeds = [];
      for (let vi = 0; vi < nVerts; vi += 1) {
        const px = positions[vi * 3];
        const py = positions[vi * 3 + 1];
        const pz = positions[vi * 3 + 2];
        if (distToBoneSq(px, py, pz, b) <= seedRSq) seeds.push(vi);
      }
      if (seeds.length === 0) {
        let bestVi = 0;
        let bestD = Infinity;
        for (let vi = 0; vi < nVerts; vi += 1) {
          const d = distToBoneSq(
            positions[vi * 3],
            positions[vi * 3 + 1],
            positions[vi * 3 + 2],
            b
          );
          if (d < bestD) {
            bestD = d;
            bestVi = vi;
          }
        }
        seeds.push(bestVi);
      }
      floodSurfaceReachable(adj, positions, seeds, maxSurf, surfaceMask, b * nVerts);
    }
  }

  function surfaceAllows(vi, boneIndex) {
    return !surfaceMask || surfaceMask[boneIndex * nVerts + vi] === 1;
  }

  function visibilityToBone(px, py, pz, boneIndex) {
    if (!useVisibilityGate) return 1;
    let sum = 0;
    let count = 0;
    const head = headW[boneIndex];
    const tails = tailsW[boneIndex];
    for (let t = 0; t < tails.length; t += 1) {
      const tail = tails[t];
      for (let s = 0; s < visibilitySamples; s += 1) {
        const u = visibilitySamples === 1 ? 0.5 : s / (visibilitySamples - 1);
        const qx = head[0] + (tail[0] - head[0]) * u;
        const qy = head[1] + (tail[1] - head[1]) * u;
        const qz = head[2] + (tail[2] - head[2]) * u;
        sum += segmentVolumeVisibility(grid, px, py, pz, qx, qy, qz);
        count += 1;
      }
    }
    if (count === 0) {
      return segmentVolumeVisibility(grid, px, py, pz, head[0], head[1], head[2]);
    }
    return sum / count;
  }

  function assignStatic(vi) {
    uncoveredVertices += 1;
    const bone = staticBoneIndex >= 0 ? staticBoneIndex : 0;
    boneWeights[vi * K] = 1;
    boneIndices[vi * K] = bone;
    for (let k = 1; k < K; k += 1) {
      boneWeights[vi * K + k] = 0;
      boneIndices[vi * K + k] = bone;
    }
  }

  for (let vi = 0; vi < nVerts; vi += 1) {
    const px = positions[vi * 3];
    const py = positions[vi * 3 + 1];
    const pz = positions[vi * 3 + 2];
    const vx = Math.floor((px - grid.origin[0]) / grid.cell);
    const vy = Math.floor((py - grid.origin[1]) / grid.cell);
    const vz = Math.floor((pz - grid.origin[2]) / grid.cell);

    acc.fill(0);
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = vx + dx;
          const ny = vy + dy;
          const nz = vz + dz;
          if (!inGrid(grid, nx, ny, nz)) continue;
          const idx = gridIndex(grid, nx, ny, nz);
          if (!grid.solid[idx]) continue;
          const weight = 1 / (1 + dx * dx + dy * dy + dz * dz);
          for (let k = 0; k < K; k += 1) {
            const bi = topB[idx * K + k];
            if (bi < 0 || bones[bi]?.skip) continue;
            acc[bi] += weight * topW[idx * K + k];
          }
        }
      }
    }

    // Euclidean capture + optional hard surface gate + soft volume visibility.
    for (let b = 0; b < nBones; b += 1) {
      if (acc[b] <= 0 || bones[b].skip) continue;
      if (distToBoneSq(px, py, pz, b) > captureRadiusSq || !surfaceAllows(vi, b)) {
        acc[b] = 0;
        continue;
      }
      const vis = visibilityToBone(px, py, pz, b);
      // Soft square keeps near-full influence when mostly visible; crush air-gap paths.
      acc[b] *= vis * vis;
      if (acc[b] < minWeight) acc[b] = 0;
    }

    let accSum = 0;
    for (let b = 0; b < nBones; b += 1) accSum += acc[b];

    if (accSum <= 0) {
      // Local Euclidean capture only — never "nearest bone anywhere in body".
      const rankedLocal = [];
      for (let b = 0; b < nBones; b += 1) {
        if (bones[b].skip) continue;
        if (!surfaceAllows(vi, b)) continue;
        const d2 = distToBoneSq(px, py, pz, b);
        if (d2 > captureRadiusSq) continue;
        const vis = visibilityToBone(px, py, pz, b);
        if (vis < 0.08) continue;
        const d = Math.sqrt(d2) + 1e-6;
        rankedLocal.push([b, (vis * vis) / (d * d)]);
      }
      if (rankedLocal.length === 0) {
        assignStatic(vi);
        continue;
      }
      rankedLocal.sort((a, b) => b[1] - a[1]);
      const top = rankedLocal.slice(0, K);
      let sum = 0;
      for (const entry of top) sum += entry[1];
      const inv = 1 / sum;
      for (let k = 0; k < K; k += 1) {
        if (k < top.length) {
          boneWeights[vi * K + k] = top[k][1] * inv;
          boneIndices[vi * K + k] = top[k][0];
        } else {
          boneWeights[vi * K + k] = 0;
          boneIndices[vi * K + k] = top[0][0];
        }
      }
      continue;
    }

    const ranked = [];
    for (let b = 0; b < nBones; b += 1) {
      if (acc[b] >= minWeight) ranked.push([b, acc[b]]);
    }
    ranked.sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) {
      assignStatic(vi);
      continue;
    }

    const top = ranked.slice(0, K);
    let sum = 0;
    for (const entry of top) sum += entry[1];
    const inv = sum > 0 ? 1 / sum : 1;
    for (let k = 0; k < K; k += 1) {
      if (k < top.length) {
        boneWeights[vi * K + k] = top[k][1] * inv;
        boneIndices[vi * K + k] = top[k][0];
      } else {
        boneWeights[vi * K + k] = 0;
        boneIndices[vi * K + k] = top[0][0];
      }
    }
  }

  let solidCount = 0;
  for (let i = 0; i < V; i += 1) if (grid.solid[i]) solidCount += 1;

  return {
    boneWeights,
    boneIndices,
    boneCount: nBones,
    uncoveredVertices,
    captureRadius,
    surfaceGate: useSurfaceGate,
    visibilityGate: useVisibilityGate,
    grid: {
      sx: grid.sx,
      sy: grid.sy,
      sz: grid.sz,
      cell: grid.cell,
      solidCount
    },
    method: 'voxelBind'
  };
}

/**
 * Soft visibility of segment p→q through the solid voxel volume (Pinocchio-style).
 * Returns 0..1. Paths that leave the body then re-enter (air-gap crotch) are crushed.
 * Empty cells before first solid are ignored (vertex sits on the outer shell).
 */
function segmentVolumeVisibility(grid, ax, ay, az, bx, by, bz) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-10) {
    return sampleSolid(grid, ax, ay, az) ? 1 : 0.25;
  }
  const step = Math.max(grid.cell * 0.45, len / 48);
  const steps = Math.max(4, Math.ceil(len / step));
  let solid = 0;
  let empty = 0;
  let entered = false;
  let leftAfterEnter = false;
  let reentered = false;

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = ax + dx * t;
    const y = ay + dy * t;
    const z = az + dz * t;
    const inside = sampleSolid(grid, x, y, z);
    if (!entered) {
      if (inside) {
        entered = true;
        solid += 1;
      }
      // Still outside / on shell before penetrating — ignore.
      continue;
    }
    if (inside) {
      solid += 1;
      if (leftAfterEnter) reentered = true;
    } else {
      empty += 1;
      leftAfterEnter = true;
    }
  }

  if (!entered) {
    // Never found solid — bone sample likely outside flood fill; weak keep.
    return 0.15;
  }
  const denom = solid + empty;
  let frac = denom > 0 ? solid / denom : 0;
  if (reentered) {
    // Classic false neighbor: through air into the other limb.
    frac *= 0.04;
  } else if (empty > 0) {
    // Soften partial exits without full re-entry.
    frac *= Math.max(0.15, 1 - empty / denom);
  }
  return Math.max(0, Math.min(1, frac));
}

function sampleSolid(grid, x, y, z) {
  const ix = Math.floor((x - grid.origin[0]) / grid.cell);
  const iy = Math.floor((y - grid.origin[1]) / grid.cell);
  const iz = Math.floor((z - grid.origin[2]) / grid.cell);
  if (!inGrid(grid, ix, iy, iz)) return false;
  return Boolean(grid.solid[gridIndex(grid, ix, iy, iz)]);
}

function buildMeshAdjacency(indices, nVerts) {
  const sets = Array.from({ length: nVerts }, () => new Set());
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] | 0;
    const b = indices[t + 1] | 0;
    const c = indices[t + 2] | 0;
    if (a === b || b === c || c === a) continue;
    if (a < 0 || b < 0 || c < 0 || a >= nVerts || b >= nVerts || c >= nVerts) continue;
    sets[a].add(b);
    sets[b].add(a);
    sets[b].add(c);
    sets[c].add(b);
    sets[c].add(a);
    sets[a].add(c);
  }
  return sets.map((set) => Uint32Array.from(set));
}

/**
 * Metric flood on the mesh graph. Marks outMask[base + vi] = 1 when surface
 * distance from any seed ≤ maxDist.
 */
function floodSurfaceReachable(adj, positions, seeds, maxDist, outMask, base) {
  const nVerts = (positions.length / 3) | 0;
  const dist = new Float32Array(nVerts);
  dist.fill(Infinity);
  /** @type {number[]} */
  const open = [];
  for (const raw of seeds) {
    const s = raw | 0;
    if (s < 0 || s >= nVerts) continue;
    if (dist[s] === 0) continue;
    dist[s] = 0;
    open.push(s);
  }
  while (open.length) {
    let best = 0;
    for (let i = 1; i < open.length; i += 1) {
      if (dist[open[i]] < dist[open[best]]) best = i;
    }
    const u = open[best];
    open[best] = open[open.length - 1];
    open.pop();
    const du = dist[u];
    if (!(du <= maxDist)) continue;
    outMask[base + u] = 1;
    const neighbors = adj[u];
    for (let n = 0; n < neighbors.length; n += 1) {
      const v = neighbors[n];
      const el = Math.hypot(
        positions[v * 3] - positions[u * 3],
        positions[v * 3 + 1] - positions[u * 3 + 1],
        positions[v * 3 + 2] - positions[u * 3 + 2]
      );
      const nd = du + el;
      if (nd < dist[v] && nd <= maxDist) {
        const first = dist[v] === Infinity;
        dist[v] = nd;
        if (first) open.push(v);
      }
    }
  }
}

function distPointSegmentSq(px, py, pz, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq < 1e-14) {
    const dx = px - a[0];
    const dy = py - a[1];
    const dz = pz - a[2];
    return dx * dx + dy * dy + dz * dz;
  }
  let t = ((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + abx * t;
  const qy = a[1] + aby * t;
  const qz = a[2] + abz * t;
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

function insertTopK(topW, topB, base, K, w, bone) {
  if (w <= topW[base + K - 1]) return;
  topW[base + K - 1] = w;
  topB[base + K - 1] = bone;
  for (let i = K - 1; i > 0 && topW[base + i] > topW[base + i - 1]; i -= 1) {
    const tw = topW[base + i];
    topW[base + i] = topW[base + i - 1];
    topW[base + i - 1] = tw;
    const tb = topB[base + i];
    topB[base + i] = topB[base + i - 1];
    topB[base + i - 1] = tb;
  }
}

function makeGrid(positions, maxRes) {
  let mnX = positions[0];
  let mnY = positions[1];
  let mnZ = positions[2];
  let mxX = mnX;
  let mxY = mnY;
  let mxZ = mnZ;
  for (let i = 3; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
    if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
  }
  const extX = mxX - mnX;
  const extY = mxY - mnY;
  const extZ = mxZ - mnZ;
  const maxExt = Math.max(extX, extY, extZ);
  if (maxExt < 1e-12) return { sx: 0, sy: 0, sz: 0, cell: 0, origin: [0, 0, 0], solid: [] };

  const cell = maxExt / Math.max(8, maxRes - 4);
  const pad = 2;
  const sx = Math.ceil(extX / cell) + 2 * pad;
  const sy = Math.ceil(extY / cell) + 2 * pad;
  const sz = Math.ceil(extZ / cell) + 2 * pad;
  return {
    sx, sy, sz, cell,
    origin: [mnX - pad * cell, mnY - pad * cell, mnZ - pad * cell],
    solid: new Uint8Array(sx * sy * sz)
  };
}

function gridIndex(g, x, y, z) {
  return (z * g.sy + y) * g.sx + x;
}

function inGrid(g, x, y, z) {
  return x >= 0 && x < g.sx && y >= 0 && y < g.sy && z >= 0 && z < g.sz;
}

function rasterizeSurface(positions, indices, g) {
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ia = indices[t] * 3;
    const ib = indices[t + 1] * 3;
    const ic = indices[t + 2] * 3;
    const ax = positions[ia]; const ay = positions[ia + 1]; const az = positions[ia + 2];
    const bx = positions[ib]; const by = positions[ib + 1]; const bz = positions[ib + 2];
    const cx = positions[ic]; const cy = positions[ic + 1]; const cz = positions[ic + 2];
    const e1 = Math.hypot(bx - ax, by - ay, bz - az);
    const e2 = Math.hypot(cx - ax, cy - ay, cz - az);
    const e3 = Math.hypot(cx - bx, cy - by, cz - bz);
    const eMax = Math.max(e1, e2, e3);
    const N = Math.max(2, Math.ceil(eMax / g.cell * 2) + 1);
    for (let i = 0; i <= N; i += 1) {
      for (let j = 0; j <= N - i; j += 1) {
        const u = i / N;
        const v = j / N;
        const w = 1 - u - v;
        const px = ax * w + bx * u + cx * v;
        const py = ay * w + by * u + cy * v;
        const pz = az * w + bz * u + cz * v;
        const x = Math.floor((px - g.origin[0]) / g.cell);
        const y = Math.floor((py - g.origin[1]) / g.cell);
        const z = Math.floor((pz - g.origin[2]) / g.cell);
        if (inGrid(g, x, y, z)) g.solid[gridIndex(g, x, y, z)] = 1;
      }
    }
  }
}

function fillInterior(g) {
  const n = g.solid.length;
  const exterior = new Uint8Array(n);
  const queue = [];
  const push = (x, y, z) => {
    if (!inGrid(g, x, y, z)) return;
    const i = gridIndex(g, x, y, z);
    if (g.solid[i] || exterior[i]) return;
    exterior[i] = 1;
    queue.push(i);
  };
  push(0, 0, 0);
  const dx = [1, -1, 0, 0, 0, 0];
  const dy = [0, 0, 1, -1, 0, 0];
  const dz = [0, 0, 0, 0, 1, -1];
  let qh = 0;
  while (qh < queue.length) {
    const i = queue[qh++];
    const z = (i / (g.sx * g.sy)) | 0;
    const rem = i - z * g.sx * g.sy;
    const y = (rem / g.sx) | 0;
    const x = rem - y * g.sx;
    for (let k = 0; k < 6; k += 1) push(x + dx[k], y + dy[k], z + dz[k]);
  }
  for (let i = 0; i < n; i += 1) {
    if (!exterior[i]) g.solid[i] = 1;
  }
}

function seedVoxels(g, head, tail) {
  const seeds = [];
  const dx = tail[0] - head[0];
  const dy = tail[1] - head[1];
  const dz = tail[2] - head[2];
  const L = Math.hypot(dx, dy, dz);
  const steps = Math.max(2, Math.ceil(L / (g.cell * 0.5)));
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const px = head[0] + dx * t;
    const py = head[1] + dy * t;
    const pz = head[2] + dz * t;
    const x = Math.floor((px - g.origin[0]) / g.cell);
    const y = Math.floor((py - g.origin[1]) / g.cell);
    const z = Math.floor((pz - g.origin[2]) / g.cell);
    if (inGrid(g, x, y, z)) {
      const idx = gridIndex(g, x, y, z);
      if (g.solid[idx]) seeds.push(idx);
    }
  }
  if (seeds.length === 0) {
    const bx = Math.floor((head[0] - g.origin[0]) / g.cell);
    const by = Math.floor((head[1] - g.origin[1]) / g.cell);
    const bz = Math.floor((head[2] - g.origin[2]) / g.cell);
    let best = -1;
    let bestDistSq = Infinity;
    for (let z = 0; z < g.sz; z += 1) {
      for (let y = 0; y < g.sy; y += 1) {
        for (let x = 0; x < g.sx; x += 1) {
          if (!g.solid[gridIndex(g, x, y, z)]) continue;
          const d2 = (x - bx) ** 2 + (y - by) ** 2 + (z - bz) ** 2;
          if (d2 < bestDistSq) {
            bestDistSq = d2;
            best = gridIndex(g, x, y, z);
          }
        }
      }
    }
    if (best >= 0) seeds.push(best);
  }
  return [...new Set(seeds)];
}

function bfsFromSeeds(g, seeds, dist, maxHops) {
  dist.fill(INF);
  const queue = [];
  for (const s of seeds) {
    dist[s] = 0;
    queue.push(s);
  }
  const ox = [1, -1, 0, 0, 0, 0];
  const oy = [0, 0, 1, -1, 0, 0];
  const oz = [0, 0, 0, 0, 1, -1];
  let qh = 0;
  while (qh < queue.length) {
    const i = queue[qh++];
    if (maxHops > 0 && dist[i] >= maxHops) continue;
    const z = (i / (g.sx * g.sy)) | 0;
    const rem = i - z * g.sx * g.sy;
    const y = (rem / g.sx) | 0;
    const x = rem - y * g.sx;
    const nd = dist[i] + 1;
    for (let k = 0; k < 6; k += 1) {
      const nx = x + ox[k];
      const ny = y + oy[k];
      const nz = z + oz[k];
      if (!inGrid(g, nx, ny, nz)) continue;
      const ni = gridIndex(g, nx, ny, nz);
      if (!g.solid[ni] || dist[ni] <= nd) continue;
      dist[ni] = nd;
      queue.push(ni);
    }
  }
}

/**
 * Collect world-space triangle mesh buffers from a BufferGeometry.
 */
export function geometryToMeshBuffers(geometry) {
  const position = geometry.getAttribute('position');
  if (!position) throw new TypeError('geometry 缺少 position');
  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }

  let indices;
  const index = geometry.getIndex();
  if (index) {
    indices = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i += 1) indices[i] = index.getX(i);
  } else {
    const n = position.count;
    if (n % 3 !== 0) {
      throw new TypeError('无索引 geometry 顶点数不是 3 的倍数');
    }
    indices = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) indices[i] = i;
  }
  return { positions, indices };
}
