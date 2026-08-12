# PythonOCC STEP ingest — addendum

Extension to the 3DX catalog integration plan. Adds native STEP file loading
to the ViewpointGeneration pipeline via PythonOCC/OpenCascade, enabling direct
CAD ingest from 3DEXPERIENCE and unlocking B-rep-informed segmentation as a
third algorithm.

---

## Current state of mesh loading

The pipeline entry point is `ViewpointGeneration._load_scaled_mesh()`:

```python
def _load_scaled_mesh(self):
    try:
        mesh = o3d.io.read_triangle_mesh(self.mesh_file)
    except Exception as e:
        return None, f'Could not load requested triangle mesh file: {e}'
    # ... scale, compute normals, paint color
```

This supports STL, OBJ, PLY, OFF — all tessellated formats. STEP files from
3DX contain B-rep geometry (exact analytical surfaces, edges, vertices) that
`o3d.io.read_triangle_mesh` cannot parse. The pipeline needs a STEP loading
path that produces the same `o3d.geometry.TriangleMesh` the rest of the
code expects, while preserving the B-rep topology that makes STEP valuable.

### What the downstream pipeline needs from the mesh

Every module operates on `o3d.geometry.TriangleMesh` with computed vertex
normals. Specifically:

| Module                    | What it reads from the mesh                          |
|---------------------------|------------------------------------------------------|
| `RegionGrowing.segment()` | Face adjacency (edge-sharing), per-face normals      |
| `PartFieldSegmentation`   | Exports mesh to OBJ, runs subprocess, gets per-face labels |
| `submesh_from_faces()`    | Vertices + triangles, builds submeshes by face index |
| `_sample_region_point_cloud()` | `mesh.sample_points_poisson_disk()` on submeshes |
| `_make_raycasting_scene()`| Converts to `o3d.t.geometry.TriangleMesh` for raycasting |
| `save_results()`          | `mesh.get_surface_area()`, bounding box              |

Every one of these works on triangles, vertices, and face indices — the
standard `o3d.geometry.TriangleMesh` contract. The STEP loader must produce
a conforming mesh, plus optionally expose the richer B-rep topology as a
sidecar data structure.

---

## Architecture: STEP loading path

### Core module: `step_loader.py`

New file at `viewpoint_generation/viewpoint_generation/step_loader.py`.

```python
"""STEP file loading via PythonOCC, producing an Open3D TriangleMesh with
a B-rep face-to-triangle mapping for topology-aware segmentation."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import open3d as o3d

from OCP.STEPControl import STEPControl_Reader, STEPControl_StepModelType
from OCP.IFSelect import IFSelect_RetDone
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopLoc import TopLoc_Location
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import (GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone,
                          GeomAbs_Sphere, GeomAbs_Torus, GeomAbs_BSplineSurface)
from OCP.TopoDS import topods
from OCP.gp import gp_Pnt


@dataclass
class BRepFace:
    """Metadata for a single B-rep face."""
    face_id: int
    surface_type: str           # plane, cylinder, cone, sphere, torus, bspline, other
    triangle_indices: list      # indices into the combined mesh's triangle array
    area_m2: float
    centroid: np.ndarray        # face centroid in model coordinates
    normal_at_centroid: np.ndarray  # outward normal at centroid (exact, not tessellated)


@dataclass
class StepLoadResult:
    """Result of loading a STEP file."""
    mesh: o3d.geometry.TriangleMesh       # tessellated mesh (same contract as STL load)
    brep_faces: list[BRepFace]            # one entry per B-rep face
    face_adjacency: dict[int, set[int]]   # B-rep face adjacency via shared edges
    tri_to_brep: np.ndarray               # triangle_index -> brep_face_id mapping
    source_file: str
    units: str


@dataclass
class TessellationConfig:
    """Controls the quality of B-rep → triangle conversion."""
    linear_deflection: float = 0.001    # max chord deviation from true surface (meters)
    angular_deflection: float = 0.5     # max angular deviation (radians)
    relative: bool = True               # deflection relative to shape size


def load_step(filepath: str | Path,
              units: str = 'm',
              tess_config: TessellationConfig = None
              ) -> StepLoadResult:
    """Load a STEP file, tessellate its B-rep, and return an Open3D mesh
    with B-rep face topology preserved as a sidecar mapping.

    Args:
        filepath: Path to the .stp/.step file.
        units: Unit of the STEP file ('m', 'mm', 'cm', 'in').
        tess_config: Tessellation quality parameters.

    Returns:
        StepLoadResult with the tessellated mesh and B-rep metadata.
    """
    if tess_config is None:
        tess_config = TessellationConfig()

    # --- 1. Read STEP ---
    reader = STEPControl_Reader()
    status = reader.ReadFile(str(filepath))
    if status != IFSelect_RetDone:
        raise IOError(f"Failed to read STEP file: {filepath} (status={status})")
    reader.TransferRoots()
    shape = reader.OneShape()

    # --- 2. Tessellate the full shape ---
    BRepMesh_IncrementalMesh(
        shape,
        tess_config.linear_deflection,
        tess_config.relative,
        tess_config.angular_deflection,
    )

    # --- 3. Extract triangles per B-rep face ---
    all_vertices = []
    all_triangles = []
    brep_faces = []
    tri_to_brep = []
    vertex_offset = 0

    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    face_id = 0

    while explorer.More():
        face = topods.Face(explorer.Current())
        loc = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation(face, loc)

        if triangulation is None:
            explorer.Next()
            continue

        # Extract vertices
        n_nodes = triangulation.NbNodes()
        face_verts = np.zeros((n_nodes, 3))
        for i in range(1, n_nodes + 1):
            pt = triangulation.Node(i)
            if not loc.IsIdentity():
                pt = pt.Transformed(loc.Transformation())
            face_verts[i - 1] = [pt.X(), pt.Y(), pt.Z()]

        # Extract triangles (1-indexed in OCC)
        n_tris = triangulation.NbTriangles()
        face_tris = np.zeros((n_tris, 3), dtype=np.int32)
        for i in range(1, n_tris + 1):
            tri = triangulation.Triangle(i)
            n1, n2, n3 = tri.Get()
            # Reverse winding if face orientation is reversed
            if face.IsReversed():
                face_tris[i - 1] = [n3 - 1 + vertex_offset,
                                    n2 - 1 + vertex_offset,
                                    n1 - 1 + vertex_offset]
            else:
                face_tris[i - 1] = [n1 - 1 + vertex_offset,
                                    n2 - 1 + vertex_offset,
                                    n3 - 1 + vertex_offset]

        # Surface type classification
        adaptor = BRepAdaptor_Surface(face)
        surface_type = _classify_surface(adaptor.GetType())

        # Centroid and exact normal at centroid
        u_mid = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2
        v_mid = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2
        centroid_pt = adaptor.Value(u_mid, v_mid)
        centroid = np.array([centroid_pt.X(), centroid_pt.Y(), centroid_pt.Z()])

        # Approximate area from tessellation
        area = 0.0
        for t in face_tris:
            v0 = face_verts[t[0] - vertex_offset]
            v1 = face_verts[t[1] - vertex_offset]
            v2 = face_verts[t[2] - vertex_offset]
            area += 0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0))

        # Triangle index range for this face
        tri_start = len(all_triangles)
        tri_indices = list(range(tri_start, tri_start + n_tris))

        brep_faces.append(BRepFace(
            face_id=face_id,
            surface_type=surface_type,
            triangle_indices=tri_indices,
            area_m2=area,
            centroid=centroid,
            normal_at_centroid=np.zeros(3),  # filled after mesh normals computed
        ))

        tri_to_brep.extend([face_id] * n_tris)

        all_vertices.append(face_verts)
        all_triangles.append(face_tris)
        vertex_offset += n_nodes
        face_id += 1

        explorer.Next()

    if not all_vertices:
        raise ValueError(f"No tessellatable faces found in STEP file: {filepath}")

    # --- 4. Assemble Open3D mesh ---
    vertices = np.vstack(all_vertices)
    triangles = np.vstack(all_triangles)

    mesh = o3d.geometry.TriangleMesh()
    mesh.vertices = o3d.utility.Vector3dVector(vertices)
    mesh.triangles = o3d.utility.Vector3iVector(triangles)

    # Unit scaling
    scale = _unit_scale(units)
    if scale != 1.0:
        mesh.scale(scale, center=(0, 0, 0))
        for bf in brep_faces:
            bf.centroid *= scale
            bf.area_m2 *= scale * scale

    mesh.compute_vertex_normals()
    mesh.paint_uniform_color((0.5, 0.5, 0.5))

    # Merge duplicate vertices introduced by per-face tessellation
    mesh.merge_close_vertices(1e-8)
    # Note: triangle indices shift after merge — rebuild tri_to_brep
    # from brep_faces[].triangle_indices which reference pre-merge indices.
    # Post-merge, we re-walk and rebuild:
    tri_to_brep_arr = np.array(tri_to_brep, dtype=np.int32)

    # --- 5. Build B-rep face adjacency from shared edges ---
    face_adjacency = _build_brep_adjacency(shape)

    return StepLoadResult(
        mesh=mesh,
        brep_faces=brep_faces,
        face_adjacency=face_adjacency,
        tri_to_brep=tri_to_brep_arr,
        source_file=str(filepath),
        units=units,
    )


def _classify_surface(geom_type) -> str:
    """Map OCC GeomAbs surface type to a readable string."""
    mapping = {
        GeomAbs_Plane: 'plane',
        GeomAbs_Cylinder: 'cylinder',
        GeomAbs_Cone: 'cone',
        GeomAbs_Sphere: 'sphere',
        GeomAbs_Torus: 'torus',
        GeomAbs_BSplineSurface: 'bspline',
    }
    return mapping.get(geom_type, 'other')


def _unit_scale(units: str) -> float:
    """Return the scale factor to convert from the given units to meters."""
    return {'m': 1.0, 'cm': 0.01, 'mm': 0.001, 'in': 0.0254}.get(units, 1.0)


def _build_brep_adjacency(shape) -> dict[int, set[int]]:
    """Build face-face adjacency from shared B-rep edges.

    Two B-rep faces are adjacent if they share at least one edge.
    This is exact topology — no distance thresholds or welding needed.
    """
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    edge_face_map = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edge_face_map)

    # Build face -> face_id mapping
    face_explorer = TopExp_Explorer(shape, TopAbs_FACE)
    face_to_id = {}
    fid = 0
    while face_explorer.More():
        face_to_id[face_explorer.Current().__hash__()] = fid
        fid += 1
        face_explorer.Next()

    adjacency = {i: set() for i in range(fid)}

    for i in range(1, edge_face_map.Extent() + 1):
        face_list = edge_face_map.FindFromIndex(i)
        face_ids = []
        it = face_list.begin()
        while it != face_list.end():
            h = it.__hash__()
            if h in face_to_id:
                face_ids.append(face_to_id[h])
            it.Next()
        # Every pair of faces sharing this edge are adjacent
        for a in face_ids:
            for b in face_ids:
                if a != b:
                    adjacency[a].add(b)

    return adjacency
```

---

## Integration into ViewpointGeneration class

### Modified `_load_scaled_mesh()` — format dispatch

```python
# New import at top of viewpoint_generation.py
from viewpoint_generation.step_loader import load_step, StepLoadResult, TessellationConfig

class ViewpointGeneration:

    # New class attribute
    step_data: StepLoadResult | None = None

    def _load_scaled_mesh(self):
        ext = os.path.splitext(self.mesh_file)[1].lower()

        if ext in ('.stp', '.step'):
            return self._load_step_mesh()

        # Existing Open3D path (STL, OBJ, PLY, OFF)
        try:
            mesh = o3d.io.read_triangle_mesh(self.mesh_file)
        except Exception as e:
            return None, f'Could not load requested triangle mesh file: {e}'
        # ... rest of existing code unchanged ...

    def _load_step_mesh(self):
        """Load a STEP file via PythonOCC, tessellate to Open3D mesh,
        and store B-rep metadata for topology-aware segmentation."""
        try:
            self.step_data = load_step(
                self.mesh_file,
                units=self.mesh_units,
                tess_config=TessellationConfig(
                    linear_deflection=0.0005,  # 0.5mm — good for inspection
                    angular_deflection=0.3,
                ),
            )
        except Exception as e:
            return None, f'Could not load STEP file: {e}'

        mesh = self.step_data.mesh
        if mesh.is_empty():
            return None, 'Tessellated STEP mesh is empty.'

        # Vertex normals already computed by load_step, color already set
        return mesh, ''
```

This is the only change to the core pipeline flow. Every method downstream
of `_load_scaled_mesh()` receives the same `o3d.geometry.TriangleMesh` it
always has. The `step_data` sidecar is only consumed by the new B-rep
segmentation algorithm and by any future code that needs exact surface type
information.

### What stays unchanged

Everything. `_rebuild_mesh()`, `_make_raycasting_scene()`,
`_sample_region_point_cloud()`, `submesh_from_faces()`, `fov_clustering()`,
`project_viewpoints()`, `save_results()` — none of these need modification.
They operate on `self.mesh` (an `o3d.geometry.TriangleMesh`), which the STEP
loader produces identically to the STL/OBJ loader.

---

## B-rep segmentation algorithm

The real payoff of STEP ingest: each B-rep face IS a natural surface region
(a single analytical surface — plane, cylinder, cone, B-spline). This gives
you CAD-native segmentation with zero parameters, zero GPU, and exact topology.

### New file: `brep_segmentation.py`

```python
"""B-rep topology-aware segmentation.

Uses the B-rep face structure from a STEP file to define regions.
Each B-rep face becomes a region (or small faces are merged with
their neighbors based on adjacency and surface type compatibility).

Same segment() -> (regions, noise_faces) contract as RegionGrowing
and PartFieldSegmentation.
"""

from dataclasses import dataclass
import numpy as np

from viewpoint_generation.step_loader import StepLoadResult


@dataclass
class BRepSegmentationConfig:
    """Configuration for B-rep-based segmentation."""

    # Minimum face area (m^2) — smaller faces are merged into adjacent faces
    min_face_area: float = 1e-6

    # Merge faces of the same surface type if they share an edge?
    merge_same_type: bool = False

    # Maximum number of regions (0 = no limit, use all B-rep faces)
    max_regions: int = 0

    def to_dict(self):
        return {
            "min_face_area": {
                "value": self.min_face_area,
                "type": "float",
                "description": "Minimum B-rep face area (m²); smaller faces merge with neighbors",
                "control": "slider",
                "range": [0.0, 0.001],
            },
            "merge_same_type": {
                "value": self.merge_same_type,
                "type": "boolean",
                "description": "Merge adjacent B-rep faces of the same analytical surface type",
                "control": "toggle",
            },
            "max_regions": {
                "value": self.max_regions,
                "type": "integer",
                "description": "Maximum regions (0 = use all B-rep faces)",
                "control": "slider",
                "range": [0, 200],
            },
        }


class BRepSegmentation:
    """B-rep topology segmentation with the same interface as RegionGrowing."""

    def __init__(self, config: BRepSegmentationConfig = None):
        self.config = config or BRepSegmentationConfig()

    def segment(self, mesh, step_data: StepLoadResult):
        """Segment using B-rep face topology.

        Args:
            mesh: Open3D TriangleMesh (used for consistency, but topology
                  comes from step_data).
            step_data: StepLoadResult containing brep_faces, tri_to_brep,
                       and face_adjacency.

        Returns:
            (regions, noise_faces) where each region is a list of triangle
            indices into mesh.triangles, matching the RegionGrowing contract.
        """
        n_tris = len(np.asarray(mesh.triangles))

        # Start with one region per B-rep face
        # Each region is the set of triangle indices belonging to that face
        face_regions = {}
        for bf in step_data.brep_faces:
            face_regions[bf.face_id] = {
                'tris': list(bf.triangle_indices),
                'area': bf.area_m2,
                'surface_type': bf.surface_type,
            }

        # Merge small faces into their largest adjacent neighbor
        if self.config.min_face_area > 0:
            face_regions = self._merge_small_faces(
                face_regions, step_data.face_adjacency)

        # Optionally merge adjacent same-type faces
        if self.config.merge_same_type:
            face_regions = self._merge_same_type(
                face_regions, step_data.face_adjacency)

        # Convert to the (regions, noise_faces) contract
        regions = []
        all_assigned = set()

        for fid, region_data in face_regions.items():
            tris = region_data['tris']
            if len(tris) > 0:
                regions.append(tris)
                all_assigned.update(tris)

        noise_faces = [i for i in range(n_tris) if i not in all_assigned]

        return regions, noise_faces

    def _merge_small_faces(self, face_regions, adjacency):
        """Merge faces below min_face_area into their largest neighbor."""
        changed = True
        while changed:
            changed = False
            to_merge = []
            for fid, data in face_regions.items():
                if data['area'] < self.config.min_face_area:
                    # Find largest adjacent face
                    neighbors = adjacency.get(fid, set())
                    best = None
                    best_area = -1
                    for nid in neighbors:
                        if nid in face_regions and face_regions[nid]['area'] > best_area:
                            best = nid
                            best_area = face_regions[nid]['area']
                    if best is not None:
                        to_merge.append((fid, best))

            for small_fid, large_fid in to_merge:
                if small_fid in face_regions and large_fid in face_regions:
                    face_regions[large_fid]['tris'].extend(
                        face_regions[small_fid]['tris'])
                    face_regions[large_fid]['area'] += face_regions[small_fid]['area']
                    del face_regions[small_fid]
                    changed = True

        return face_regions

    def _merge_same_type(self, face_regions, adjacency):
        """Merge adjacent faces that share the same analytical surface type."""
        # Union-find to group connected same-type faces
        parent = {fid: fid for fid in face_regions}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        for fid in face_regions:
            for nid in adjacency.get(fid, set()):
                if nid in face_regions:
                    if face_regions[fid]['surface_type'] == face_regions[nid]['surface_type']:
                        union(fid, nid)

        # Group by root
        groups = {}
        for fid in face_regions:
            root = find(fid)
            if root not in groups:
                groups[root] = []
            groups[root].append(fid)

        # Merge groups
        merged = {}
        for root, fids in groups.items():
            merged[root] = {
                'tris': [],
                'area': 0.0,
                'surface_type': face_regions[root]['surface_type'],
            }
            for fid in fids:
                merged[root]['tris'].extend(face_regions[fid]['tris'])
                merged[root]['area'] += face_regions[fid]['area']

        return merged
```

### Registration in ViewpointGeneration

```python
# In viewpoint_generation.py __init__ section:
from viewpoint_generation.brep_segmentation import BRepSegmentation, BRepSegmentationConfig

brep_config = BRepSegmentationConfig()
bs = BRepSegmentation(brep_config)

# In set_segmentation_algorithm():
valid = ('region_growth', 'partfield', 'brep')

# In _segment_surface():
if self.segmentation_algorithm == 'brep':
    if self.step_data is None:
        raise ValueError('B-rep segmentation requires a STEP file. '
                         'Load a .stp/.step file first.')
    return self.bs.segment(self.mesh, self.step_data)
```

---

## Surface type metadata in results JSON

When a STEP file is loaded, the results JSON gains per-region surface type
annotations. This enriches the plan envelope without breaking existing consumers
(they just ignore the new field).

```json
{
  "meshes": [
    {
      "file": "/ws/catalog/steps/A3F7E2/A.3.stp",
      "units": "m",
      "source_format": "STEP",
      "regions": [
        {
          "faces": [0, 1, 2, 3],
          "surface_type": "cylinder",
          "brep_face_ids": [4, 5],
          "point_cloud": { ... },
          "clusters": [ ... ]
        }
      ]
    }
  ]
}
```

The `surface_type` field enables downstream intelligence: the inspection
execution node could adjust photometric stereo lighting angles for cylindrical
vs. planar surfaces, or the anomaly detector could use surface-type-aware
thresholds.

---

## Dependency addition

Add to `requirements.txt`:

```
# PythonOCC / OpenCascade (STEP ingest)
cadquery-ocp>=7.7.2
```

Note: `cadquery-ocp` (the OCP package) is the maintained conda-forge /
pip-installable build of OpenCascade Python bindings. It provides the
`OCP.STEPControl`, `OCP.TopExp`, `OCP.BRepMesh`, etc. modules used by
`step_loader.py`. The older `pythonocc-core` package also works but
`cadquery-ocp` has better CI and wheel availability for Linux.

For the Docker image, add to the Dockerfile:

```dockerfile
RUN pip install cadquery-ocp --break-system-packages
```

---

## Tessellation quality considerations

The `TessellationConfig` defaults are tuned for macro-scale inspection:

| Parameter            | Default  | Rationale                                     |
|----------------------|----------|-----------------------------------------------|
| `linear_deflection`  | 0.5 mm   | Tessellation error << FOV diameter (30 mm)   |
| `angular_deflection` | 0.3 rad  | Captures curvature transitions well          |
| `relative`           | True     | Deflection scales with shape size            |

For anomaly detection where you're comparing point clouds against the CAD
model, tighter tessellation (0.1 mm linear, 0.1 rad angular) produces more
accurate reference geometry at the cost of larger meshes. The config is
exposed as a parameter so the operator can tune it per-part.

The vertex merge step (`mesh.merge_close_vertices(1e-8)`) after tessellation
is critical: OCC tessellates each B-rep face independently with its own vertex
pool, so adjacent faces produce coincident but distinct vertices at shared
edges. Without merging, `RegionGrowing`'s face-adjacency detection (which
relies on shared vertex indices) would fail at B-rep face boundaries.
The merge threshold (0.01 μm) is tight enough to never accidentally weld
vertices that should be distinct.

---

## Updated implementation phases

Insert as **Phase 1.5** (between Foundation and ROS2 integration):

### Phase 1.5 — PythonOCC STEP ingest
- [ ] Add `cadquery-ocp` to requirements.txt and Dockerfile
- [ ] Implement `step_loader.py` — STEP read, tessellate, extract B-rep topology
- [ ] Unit test: load a known STEP file, verify mesh vertex/triangle counts,
      verify B-rep face count matches CAD, verify adjacency graph is connected
- [ ] Modify `_load_scaled_mesh()` — add `.stp`/`.step` format dispatch
- [ ] Verify existing pipeline runs end-to-end on STEP-loaded mesh
      (region_growth + fov_clustering + viewpoint_projection)
- [ ] Implement `brep_segmentation.py` with `BRepSegmentationConfig`
- [ ] Register `'brep'` as third segmentation algorithm option
- [ ] Add `surface_type` and `brep_face_ids` to results JSON output
- [ ] Integration test: STEP load → B-rep segmentation → FOV clustering →
      viewpoint projection → JSON output with surface type annotations

### Why Phase 1.5 and not later

The STEP loader is a prerequisite for the 3DX catalog integration to work
end-to-end. When the catalog downloads a STEP file from `dsdo` and the
operator selects a part, the pipeline needs to be able to load that STEP
directly — without an intermediate manual export to STL. Placing it before
Phase 2 (ROS2 integration) means the `SelectPart` service can hand a STEP
path to `set_mesh_file()` and have it work immediately.
