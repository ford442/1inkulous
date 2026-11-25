// The frame's one exposure curve: lifts the shadowed limb without blowing out
// the lit side. Applied once, by composite.wgsl, to the whole linear frame;
// the canvas adds no tone mapping of its own.
fn exposure(color: vec3f) -> vec3f {
  return vec3f(1.0) - exp(-1.35 * color);
}
