// Planet normals rebuilt on the GPU after a sculpt, over just the vertex range
// that changed. The CPU moves the vertices (positions are what picking and the
// core agree on) and uploads them; this pass then recomputes each vertex's
// normal from every triangle around its welded position — the same area-
// weighted sum refreshVertices makes on the CPU, so a seam between two cube
// faces still shades as one surface.
//
// Every vertex in the range is recomputed, not only those that moved: the
// upload just wrote the CPU's copy of each one's normal, which the CPU no
// longer keeps current.

const VERTEX_FLOATS: u32 = 8u;

struct Range {
  first: u32,
  count: u32,
}

@group(0) @binding(0) var<storage, read_write> vertices: array<f32>;
@group(0) @binding(1) var<storage, read> indices: array<u32>;
@group(0) @binding(2) var<storage, read> weldIds: array<u32>;
@group(0) @binding(3) var<storage, read> weldTriangleOffsets: array<u32>;
@group(0) @binding(4) var<storage, read> weldTriangles: array<u32>;
@group(0) @binding(5) var<uniform> range: Range;

fn positionOf(vertex: u32) -> vec3f {
  let base = vertex * VERTEX_FLOATS;
  return vec3f(vertices[base], vertices[base + 1u], vertices[base + 2u]);
}

@compute @workgroup_size(64)
fn cs_normals(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= range.count) {
    return;
  }
  let vertex = range.first + id.x;
  let weld = weldIds[vertex];
  var sum = vec3f(0.0);
  for (var t = weldTriangleOffsets[weld]; t < weldTriangleOffsets[weld + 1u]; t += 1u) {
    let triangle = weldTriangles[t] * 3u;
    let a = positionOf(indices[triangle]);
    let b = positionOf(indices[triangle + 1u]);
    let c = positionOf(indices[triangle + 2u]);
    // Unnormalised, so larger triangles weigh more.
    sum += cross(b - a, c - a);
  }
  let magnitude = length(sum);
  let normal = select(normalize(positionOf(vertex)), sum / magnitude, magnitude > 1e-8);
  let base = vertex * VERTEX_FLOATS;
  vertices[base + 3u] = normal.x;
  vertices[base + 4u] = normal.y;
  vertices[base + 5u] = normal.z;
}
