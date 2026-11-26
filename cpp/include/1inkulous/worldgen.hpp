#pragma once

#include <cstdint>

#include "1inkulous/nav.hpp"

// Procedural worlds: a seed and a handful of numbers in, one height per nav
// node out.
//
// The field is layered simplex noise on the unit sphere — a function of the 3D
// direction, so there are no seams at the cube faces and no pinching at the
// poles — laid over a few seeded continents:
//
//   continents   K seeded centres with seeded radii; near one is land
//   fBm          `octaves` of simplex noise, each `lacunarity` times the
//                frequency and `persistence` times the amplitude of the last:
//                with the continents, where the land is
//   relief       the same octaves over another patch of the noise: how high
//                the land stands where it is land
//   ridges       the relief's octaves folded (1 - |n|)², blended in for
//                chains of hills and mountains
//   warp         the point is pushed by three more noise fields before any of
//                the above is sampled, which bends coastlines and breaks up
//                the blobs
//
// The sea is not a fixed level: the field is sampled at every node and the
// level is put wherever it leaves `land` of the nodes dry, so a world asked
// for 40% land gets 40% land whatever the noise did. Before that the field is
// smoothed over its neighbours `smoothing` times, which takes one-node islands
// and pinholes out of the coast. Land then rises from a low shore over its
// first stretch inland, and stands as high as the relief field says, up to
// `peak` of the height ceiling, shaped by the `relief` exponent (above 1 the
// lowlands stay low and walkable; below 1 the land is a plateau); and it is
// smoothed over its own neighbours the same number of times. Water is exactly
// sea level.
//
// A continent is a plateau over the inner half of its radius, falling away
// smoothly to its rim: its hills and valleys are the noise's.
//
// Everything is drawn from the world's own seeded generator, not the match's:
// the same seed and parameters give the same heights, and generating a world
// does not change what the match draws next. Plain double arithmetic with
// floor, sqrt, pow and the trigonometry the rest of the core already uses, so
// it is as deterministic as the core is (see random.hpp).

namespace inkulous {

struct WorldGenParams {
  std::uint32_t seed = 1;
  // Fraction of the nodes left above the sea, 0..1.
  double land = 0.4;
  // Seeded continents the noise is laid over; 0 leaves the noise on its own.
  std::int32_t continents = 3;
  // Angular radius, in radians, of a typical continent. Each is drawn
  // between 0.6 and 1.4 times this.
  double continent_size = 0.8;
  // How much the continents decide where land is, against the noise: 0..1.
  double continent_weight = 0.55;
  // The first octave's frequency on the unit sphere.
  double frequency = 1.8;
  std::int32_t octaves = 5;
  double persistence = 0.5;
  double lacunarity = 2.0;
  // How far the domain warp pushes a sample, in units of the first octave.
  double warp = 0.25;
  // Ridged noise blended into the relief: 0 rolling, 1 all ridges.
  double ridges = 0.3;
  // Exponent on the height above the shore, in quarter steps (rounded to the
  // nearest): computed from square roots, so the core carries no general pow.
  double relief = 1.5;
  // Highest land as a fraction of the height ceiling.
  double peak = 0.9;
  // Neighbour-average passes over the land.
  std::int32_t smoothing = 1;
};

// The parameters as generate_terrain uses them: each clamped to the range it
// documents, and a non-finite value replaced by its default.
WorldGenParams sanitized(const WorldGenParams& params);

// Writes one height per node of a committed `grid`: sea level (0) or land
// above it, never above `max_height` (the terrain's ceiling; pass the cap the
// terrain holds). Returns how many nodes are land, or -1 with no grid.
std::int32_t generate_terrain(NavGrid& grid, double max_height, const WorldGenParams& params);

}  // namespace inkulous
