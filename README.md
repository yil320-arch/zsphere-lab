# ZSphere Lab

Freeform ZBrush-style **ZSphere** graph for Three.js: Joint + dense frustum Link spheres, QWER tools, and X-mirror symmetry.

This is a standalone extract of the ZSphere foundation (no puppet mesh / bind / export yet).

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
| **Q** | Extend | Click to select a Joint (outline). Drag on the **selected** Joint past a short threshold to extrude a child. Click a Link to select; press **Q** twice within ~400ms to promote it to a Joint. |
| **W** | Move | Select Joint, drag translate gizmo. Center-axis joints stay on the symmetry plane. |
| **E** | Scale | Select Joint, drag vertically to change radius. Links auto-fit. |
| **R** | Rotate | Select child A → preview parent B → click B to bind → rotate subtree about parent gizmo. |
| **X** | X-ray | Translucent preview (depth still on by default). |

Root Joint is placed with the **放置根关节球** button (not Q). Optional toggles: **对称** (X-mirror via `symmetryBound` / `mirrorOf`), **创建中心球** (midline spine joints).

## Layout

```
demo/
  ZSphereGraph.js   # graph core (joints, links, symmetry, rotateSubtree)
  zsphere-lab.js    # interactive lab
  zsphere-lab.html
  style.css
  server.mjs
test/
  zsphere-graph.test.js
```

## License

MIT
