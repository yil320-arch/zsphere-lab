# ZSphere Lab (HUMAN RIG LAB)

Freeform ZBrush-style **ZSphere** foundation for Three.js: Joint + dense frustum Link spheres, QWER tools, X-mirror symmetry, character mesh import, `.zscene.json` save/load, and **skeleton preview with geodesic voxel auto-skin** (GLB export).

Snapshot **before Rigid Segment** work — use this tag/commit as the rollback point.

## Quick start

```bash
npm install
npm run demo
```

Open http://127.0.0.1:4173/

```bash
npm test
```

Requires Node.js ≥ 22.

## Tools

| Key | Mode | Behavior |
|-----|------|----------|
| **Q** | Extend | Click to select a Joint. Drag on the **selected** Joint past a short threshold to extrude. Select a Link, then press **Q** twice within ~400ms to promote. |
| **W** | Move | Translate gizmo. Center-axis joints stay on the symmetry plane. |
| **E** | Scale | Vertical drag changes Joint radius (skin envelope thickness). |
| **R** | Rotate | Select child → confirm parent pivot → rotate subtree. |
| **X** | X-ray | Translucent Z-spheres (depth between spheres kept). |
| **V** | Z on top | Optional: mesh does not occlude Z-spheres (default mesh is opaque). |
| **Ctrl+Z / Y** | Undo / redo | Edit graph, or preview pose when in preview mode. |
| **Home** | Reset pose | Preview: return to bind pose. |
| **Ctrl+S / O** | Save / open | `.zscene.json` (graph + embedded mesh). In preview, Ctrl+S exports GLB. |
| **Esc** | Exit preview | Discard preview pose; edit graph unchanged. |

Root Joint: **放置根关节球**. Mesh: import GLB/GLTF/OBJ (default opaque). Preview: voxel resolution + volume visibility (Bone Glow).

## Project file

- **Edit:** `.zscene.json` (`human-rig-zscene`) — Z-sphere graph + optional character mesh.
- **Export:** skinned **GLB** from preview (JOINTS / WEIGHTS).

## Layout

```
demo/
  ZSphereGraph.js      # graph core
  ZSphereHistory.js    # undo/redo
  ZSphereSceneIO.js    # mesh import + scene document
  ZSphereBind.js       # skeleton + preview + GLB
  ZSphereVoxelBind.js  # geodesic voxel bind + soft visibility
  zsphere-lab.js/.html
  style.css
  server.mjs
test/
  zsphere-*.test.js
```

## License

MIT
