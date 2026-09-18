# ZSphere Lab (HUMAN RIG LAB)

Freeform ZBrush-style **ZSphere** foundation for Three.js: Joint + dense frustum Link spheres, QWER tools, X-mirror symmetry, character mesh import, and `.zscene.json` project save/load.

Standalone extract of the HUMAN RIG LAB Z-sphere workbench. **Skeleton preview / auto-skin / GLB export are planned next** and are not in this snapshot.

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
| **E** | Scale | Vertical drag changes Joint radius (envelope thickness for future skinning). |
| **R** | Rotate | Select child → confirm parent pivot → rotate subtree. |
| **X** | X-ray | Translucent Z-spheres (depth between spheres kept). |
| **V** | Z on top | Character mesh does not occlude Z-spheres (spheres still occlude each other). |
| **Ctrl+Z / Y** | Undo / redo | Snapshot history for graph edits. |
| **Ctrl+S / O** | Save / open | `.zscene.json` project (graph + embedded mesh). |

Root Joint: **放置根关节球**. Mesh: import GLB/GLTF/OBJ, scale / fit height, opacity, always-visible toggle.

## Project file

- **Edit:** `.zscene.json` (`human-rig-zscene`) — Z-sphere graph + optional character mesh.
- **Future deliverable:** skinned **GLB** for posing in external 3D scenes (not in this release).

## Layout

```
demo/
  ZSphereGraph.js     # graph core
  ZSphereHistory.js   # undo/redo
  ZSphereSceneIO.js   # mesh import + scene document
  zsphere-lab.js/.html
  style.css
  server.mjs
test/
  zsphere-graph.test.js
  zsphere-history.test.js
  zsphere-scene-io.test.js
```

## License

MIT
