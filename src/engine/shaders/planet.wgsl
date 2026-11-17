// The planet: one cube-sphere mesh, shaded by elevation. The exposure curve at
// the end of fs_main is the only tone mapping in the frame — the canvas adds
// none of its own.

struct Uniforms {
  viewProj: mat4x4f,
  model: mat4x4f,
  // xyz: towards the sun; w: how far through a cast the cursor disc is
  // (0..1), 0 when it is not a cast
  lightDir: vec4f,
  cameraPos: vec4f,
  // x: planet radius, y: max land height, z: brush mode, w: hut site or spell
  params: vec4f,
  // xyz: unit direction under the cursor, w: brush angular radius (0 = hidden)
  brush: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) elevation: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOutput {
  let world = uniforms.model * vec4f(position, 1.0);
  // The model matrix is a pure rotation, so its upper 3x3 also rotates normals.
  let rotation = mat3x3f(
    uniforms.model[0].xyz,
    uniforms.model[1].xyz,
    uniforms.model[2].xyz,
  );

  var output: VertexOutput;
  output.clipPosition = uniforms.viewProj * world;
  output.worldPosition = world.xyz;
  output.worldNormal = normalize(rotation * normal);
  // 0 at sea level, 1 at the highest peaks. uv is unused for now, but stays in
  // the vertex layout for terrain patch texturing later.
  let height = length(position) - uniforms.params.x;
  output.elevation = clamp(height / max(uniforms.params.y, 1e-5), 0.0, 1.0);
  return output;
}

fn terrainColor(elevation: f32) -> vec3f {
  let shore = vec3f(0.76, 0.70, 0.48);
  let grass = vec3f(0.24, 0.46, 0.20);
  let forest = vec3f(0.16, 0.33, 0.16);
  let rock = vec3f(0.38, 0.35, 0.32);
  let snow = vec3f(0.92, 0.94, 0.96);

  var color = mix(shore, grass, smoothstep(0.0, 0.14, elevation));
  color = mix(color, forest, smoothstep(0.12, 0.45, elevation));
  color = mix(color, rock, smoothstep(0.45, 0.78, elevation));
  color = mix(color, snow, smoothstep(0.82, 1.0, elevation));
  return color;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);
  let lightDir = normalize(uniforms.lightDir.xyz);
  let viewDir = normalize(uniforms.cameraPos.xyz - input.worldPosition);

  let isWater = input.elevation <= 0.0005;
  let albedo = select(terrainColor(input.elevation), vec3f(0.07, 0.20, 0.38), isWater);

  let diffuse = max(dot(normal, lightDir), 0.0);
  // Cheap hemisphere ambient: sky above, ground bounce below.
  let skyMix = normal.y * 0.5 + 0.5;
  let ambient = mix(vec3f(0.10, 0.11, 0.16), vec3f(0.26, 0.30, 0.38), skyMix);

  let specularPower = select(24.0, 96.0, isWater);
  let specularStrength = select(0.06, 0.45, isWater);
  let halfway = normalize(lightDir + viewDir);
  let specular =
    pow(max(dot(normal, halfway), 0.0), specularPower) * specularStrength * step(0.0, diffuse);

  // Brush cursor: a filled disc with a bright rim, drawn in angular distance from
  // the picked direction so it wraps over terrain instead of floating above it.
  var brushTint = vec3f(0.0);
  let brushRadius = uniforms.brush.w;
  if (brushRadius > 0.0) {
    let surface = normalize(input.worldPosition);
    let angle = acos(clamp(dot(surface, uniforms.brush.xyz), -1.0, 1.0));
    // params.z carries the mode: +1 raising, -1 lowering, 2 flattening, 0
    // hovering. params.w replaces it while placing a hut or aiming a spell:
    // +1 the site is good, -1 it is not; 2 a spell being cast lands here.
    let mode = uniforms.params.z;
    var cursorColor = vec3f(0.85, 0.90, 1.00);
    if (mode > 1.5) {
      cursorColor = vec3f(0.80, 0.62, 1.00);
    } else if (mode > 0.0) {
      cursorColor = vec3f(1.00, 0.80, 0.35);
    } else if (mode < 0.0) {
      cursorColor = vec3f(0.30, 0.75, 1.00);
    }
    let site = uniforms.params.w;
    if (site > 1.5) {
      cursorColor = vec3f(1.00, 0.86, 0.45);
    } else if (site > 0.5) {
      cursorColor = vec3f(0.35, 0.95, 0.45);
    } else if (site < -0.5) {
      cursorColor = vec3f(1.00, 0.32, 0.25);
    }
    let fill = 1.0 - smoothstep(brushRadius * 0.75, brushRadius, angle);
    let ring = 1.0 - smoothstep(0.0, brushRadius * 0.18, abs(angle - brushRadius * 0.88));
    brushTint = cursorColor * (fill * 0.22 + ring * 0.55);
    // While she casts, the disc throbs and a second ring closes in from the
    // rim, reaching the centre as the spell lands.
    let castProgress = uniforms.lightDir.w;
    if (castProgress > 0.0) {
      let throb = 0.65 + 0.35 * sin(castProgress * 6.2831853 * 3.0);
      let inner = brushRadius * 0.88 * (1.0 - castProgress);
      let closing = 1.0 - smoothstep(0.0, brushRadius * 0.12, abs(angle - inner));
      brushTint = cursorColor * ((fill * 0.3 + ring * 0.55) * throb + closing * 0.6);
    }
  }

  // Rim term: makes the silhouette read as a sphere rather than a flat disc.
  let rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
  let atmosphere = vec3f(0.28, 0.45, 0.72) * rim * 0.6 * (0.25 + 0.75 * diffuse);

  var color = albedo * (ambient + vec3f(1.0, 0.97, 0.90) * diffuse);
  color += vec3f(specular) + atmosphere + brushTint;

  // Exposure curve: lifts the shadowed limb without blowing out the lit side.
  color = vec3f(1.0) - exp(-1.35 * color);

  return vec4f(color, 1.0);
}
