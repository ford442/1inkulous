#include "1inkulous/worldgen.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>
#include <vector>

namespace inkulous {
namespace {

constexpr double kPi = std::numbers::pi;

// The world's own generator: xorshift32 like MatchRandom, kept apart from it
// so generating a world draws nothing from the match.
class WorldRandom {
 public:
  explicit WorldRandom(std::uint32_t seed) : state_(seed != 0 ? seed : 0x6d2b79f5u) {
    // A few turns so neighbouring seeds part company straight away.
    for (int i = 0; i < 8; ++i) next();
  }
  std::uint32_t next() {
    state_ ^= state_ << 13;
    state_ ^= state_ >> 17;
    state_ ^= state_ << 5;
    return state_;
  }
  // [0, 1), 24 bits.
  double unit() { return static_cast<double>(next() >> 8) / 16777216.0; }

 private:
  std::uint32_t state_;
};

// 3D simplex noise (after Stefan Gustavson's public-domain reference) over a
// permutation shuffled from the world seed. About -1..1.
class Simplex {
 public:
  explicit Simplex(WorldRandom& random) {
    for (std::size_t i = 0; i < 256; ++i) {
      perm_[i] = static_cast<std::uint8_t>(i);
    }
    for (std::size_t i = 255; i > 0; --i) {
      const std::size_t j = random.next() % (i + 1);
      std::swap(perm_[i], perm_[j]);
    }
    for (std::size_t i = 0; i < 256; ++i) {
      perm_[i + 256] = perm_[i];
    }
  }

  // Out of line: it is called from a handful of places once per node per
  // octave, and inlined into each one it costs the release core kilobytes
  // for no time anyone could measure.
  __attribute__((noinline)) double operator()(double x, double y, double z) const {
    constexpr double kF3 = 1.0 / 3.0;
    constexpr double kG3 = 1.0 / 6.0;
    const double s = (x + y + z) * kF3;
    const double fi = std::floor(x + s);
    const double fj = std::floor(y + s);
    const double fk = std::floor(z + s);
    const double t = (fi + fj + fk) * kG3;
    const double x0 = x - (fi - t);
    const double y0 = y - (fj - t);
    const double z0 = z - (fk - t);

    // Which of the six tetrahedra of the skewed cube the point is in.
    int i1 = 0, j1 = 0, k1 = 0, i2 = 0, j2 = 0, k2 = 0;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1;
        i2 = 1;
        j2 = 1;
      } else if (x0 >= z0) {
        i1 = 1;
        i2 = 1;
        k2 = 1;
      } else {
        k1 = 1;
        i2 = 1;
        k2 = 1;
      }
    } else {
      if (y0 < z0) {
        k1 = 1;
        j2 = 1;
        k2 = 1;
      } else if (x0 < z0) {
        j1 = 1;
        j2 = 1;
        k2 = 1;
      } else {
        j1 = 1;
        i2 = 1;
        j2 = 1;
      }
    }

    const double x1 = x0 - i1 + kG3;
    const double y1 = y0 - j1 + kG3;
    const double z1 = z0 - k1 + kG3;
    const double x2 = x0 - i2 + 2.0 * kG3;
    const double y2 = y0 - j2 + 2.0 * kG3;
    const double z2 = z0 - k2 + 2.0 * kG3;
    const double x3 = x0 - 1.0 + 3.0 * kG3;
    const double y3 = y0 - 1.0 + 3.0 * kG3;
    const double z3 = z0 - 1.0 + 3.0 * kG3;

    // Lattice coordinates wrapped into the table. The cast of a negative
    // floor is well defined: it is an integer-valued double well in range.
    const int ii = static_cast<int>(static_cast<long long>(fi) & 255);
    const int jj = static_cast<int>(static_cast<long long>(fj) & 255);
    const int kk = static_cast<int>(static_cast<long long>(fk) & 255);

    const double n0 = corner(x0, y0, z0, hash(ii, jj, kk));
    const double n1 = corner(x1, y1, z1, hash(ii + i1, jj + j1, kk + k1));
    const double n2 = corner(x2, y2, z2, hash(ii + i2, jj + j2, kk + k2));
    const double n3 = corner(x3, y3, z3, hash(ii + 1, jj + 1, kk + 1));
    return 32.0 * (n0 + n1 + n2 + n3);
  }

 private:
  int hash(int i, int j, int k) const {
    const auto at = [this](int index) {
      return static_cast<int>(perm_[static_cast<std::size_t>(index)]);
    };
    return at(i + at(j + at(k))) % 12;
  }

  static double corner(double x, double y, double z, int gradient) {
    static constexpr int kGrad[12][3] = {{1, 1, 0}, {-1, 1, 0}, {1, -1, 0}, {-1, -1, 0},
                                         {1, 0, 1}, {-1, 0, 1}, {1, 0, -1}, {-1, 0, -1},
                                         {0, 1, 1}, {0, -1, 1}, {0, 1, -1}, {0, -1, -1}};
    double t = 0.6 - x * x - y * y - z * z;
    if (t < 0.0) {
      return 0.0;
    }
    t *= t;
    const int* g = kGrad[gradient];
    return t * t * (g[0] * x + g[1] * y + g[2] * z);
  }

  std::array<std::uint8_t, 512> perm_{};
};

double clamp(double value, double low, double high, double fallback) {
  if (!std::isfinite(value)) {
    return fallback;
  }
  return value < low ? low : value > high ? high : value;
}

std::int32_t clamp_int(std::int32_t value, std::int32_t low, std::int32_t high) {
  return value < low ? low : value > high ? high : value;
}

// x (0..1) to the power `quarters` / 4, from sqrt and products alone: the
// relief exponent is kept to quarter steps so the core does not carry a
// general pow, which on its own is a sizeable part of the wasm.
double quarter_power(double x, std::int32_t quarters) {
  const double root = std::sqrt(x);
  const double fourth = std::sqrt(root);
  double out = 1.0;
  for (std::int32_t i = 0; i < quarters / 4; ++i) {
    out *= x;
  }
  switch (quarters % 4) {
    case 1:
      return out * fourth;
    case 2:
      return out * root;
    case 3:
      return out * root * fourth;
    default:
      return out;
  }
}

struct Continent {
  double centre[3];
  double radius;
};

}  // namespace

WorldGenParams sanitized(const WorldGenParams& in) {
  const WorldGenParams defaults;
  WorldGenParams out = in;
  out.land = clamp(in.land, 0.0, 1.0, defaults.land);
  out.continents = clamp_int(in.continents, 0, 16);
  out.continent_size = clamp(in.continent_size, 0.05, kPi, defaults.continent_size);
  out.continent_weight = clamp(in.continent_weight, 0.0, 1.0, defaults.continent_weight);
  out.frequency = clamp(in.frequency, 0.1, 16.0, defaults.frequency);
  out.octaves = clamp_int(in.octaves, 1, 8);
  out.persistence = clamp(in.persistence, 0.05, 0.95, defaults.persistence);
  out.lacunarity = clamp(in.lacunarity, 1.1, 4.0, defaults.lacunarity);
  out.warp = clamp(in.warp, 0.0, 2.0, defaults.warp);
  out.ridges = clamp(in.ridges, 0.0, 1.0, defaults.ridges);
  out.relief = clamp(in.relief, 0.25, 4.0, defaults.relief);
  out.peak = clamp(in.peak, 0.05, 1.0, defaults.peak);
  out.smoothing = clamp_int(in.smoothing, 0, 8);
  return out;
}

std::int32_t generate_terrain(NavGrid& grid, double max_height, const WorldGenParams& requested) {
  if (!grid.ready()) {
    return -1;
  }
  const WorldGenParams p = sanitized(requested);
  const double ceiling =
      std::isfinite(max_height) && max_height > 0.0 ? max_height : grid.planet_radius() * 0.06;
  const std::int32_t nodes = grid.node_count();

  WorldRandom random(p.seed);
  const Simplex noise(random);
  // Each octave and each warp field samples its own far-off patch of the one
  // noise, so they do not line up with each other.
  // Eleven fields of three axes: eight octaves and the three warps.
  constexpr std::size_t kFields = 11;
  std::array<double, kFields * 3> offsets{};
  for (double& offset : offsets) {
    offset = (random.unit() - 0.5) * 512.0;
  }
  std::vector<Continent> continents(static_cast<std::size_t>(p.continents));
  for (Continent& continent : continents) {
    // Uniform on the sphere.
    const double z = 2.0 * random.unit() - 1.0;
    const double phi = 2.0 * kPi * random.unit();
    const double r = std::sqrt(1.0 - z * z);
    continent.centre[0] = r * std::cos(phi);
    continent.centre[1] = z;
    continent.centre[2] = r * std::sin(phi);
    continent.radius = p.continent_size * (0.6 + 0.8 * random.unit());
  }

  auto octave_offset = [&](int field, int axis) {
    return offsets[(static_cast<std::size_t>(field) % kFields) * 3 +
                   static_cast<std::size_t>(axis)];
  };

  std::vector<double> field(static_cast<std::size_t>(nodes));
  // 0..1 per node: how high the land there stands, where it is land.
  std::vector<double> relief_field(static_cast<std::size_t>(nodes));
  for (std::int32_t node = 0; node < nodes; ++node) {
    const float* d = grid.direction(node);
    double dir[3] = {d[0], d[1], d[2]};
    const double length = std::sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    if (length > 0.0) {
      dir[0] /= length;
      dir[1] /= length;
      dir[2] /= length;
    }

    // Domain warp: three fields at the first octave's frequency.
    double q[3] = {dir[0], dir[1], dir[2]};
    if (p.warp > 0.0) {
      for (int axis = 0; axis < 3; ++axis) {
        const int f = 8 + axis;
        q[axis] += p.warp *
                   noise(dir[0] * p.frequency + octave_offset(f, 0),
                         dir[1] * p.frequency + octave_offset(f, 1),
                         dir[2] * p.frequency + octave_offset(f, 2)) /
                   p.frequency;
      }
    }

    // Two fields from the same octaves, each its own patch of the noise:
    // where land is (fBm), and how high it stands there (fBm and ridges).
    double fbm = 0.0;
    double hills = 0.0;
    double ridged = 0.0;
    double amplitude = 1.0;
    double frequency = p.frequency;
    double total = 0.0;
    for (int octave = 0; octave < p.octaves; ++octave) {
      const double n = noise(q[0] * frequency + octave_offset(octave, 0),
                             q[1] * frequency + octave_offset(octave, 1),
                             q[2] * frequency + octave_offset(octave, 2));
      const double m = noise(q[0] * frequency + octave_offset(octave + 1, 1) + 101.0,
                             q[1] * frequency + octave_offset(octave + 1, 2) + 101.0,
                             q[2] * frequency + octave_offset(octave + 1, 0) + 101.0);
      fbm += amplitude * n;
      hills += amplitude * m;
      const double fold = 1.0 - std::fabs(m);
      ridged += amplitude * (fold * fold * 2.0 - 1.0);
      total += amplitude;
      amplitude *= p.persistence;
      frequency *= p.lacunarity;
    }
    fbm /= total;
    hills /= total;
    ridged /= total;
    double value = fbm;
    const double rise = (1.0 - p.ridges) * hills + p.ridges * ridged;
    relief_field[static_cast<std::size_t>(node)] = std::min(1.0, std::max(0.0, 0.5 + 0.75 * rise));

    if (!continents.empty()) {
      double mask = 0.0;
      for (const Continent& continent : continents) {
        const double dot =
            q[0] * continent.centre[0] + q[1] * continent.centre[1] + q[2] * continent.centre[2];
        const double qlength = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
        const double c = qlength > 0.0 ? dot / qlength : 0.0;
        const double angle = std::acos(c < -1.0 ? -1.0 : c > 1.0 ? 1.0 : c);
        // Full strength over the inner half: a continent is a plateau whose
        // hills come from the noise, not one cone rising to its centre.
        const double t = std::min(1.0, 2.0 * (1.0 - angle / continent.radius));
        if (t > 0.0) {
          const double smooth = t * t * (3.0 - 2.0 * t);
          mask = std::max(mask, smooth);
        }
      }
      value = p.continent_weight * (2.0 * mask - 1.0) + (1.0 - p.continent_weight) * value;
    }
    field[static_cast<std::size_t>(node)] = value;
  }

  const auto count = static_cast<std::size_t>(nodes);
  const std::int32_t* offsets_csr = grid.neighbor_offsets();
  const std::int32_t* neighbors = grid.neighbors();
  std::vector<double> next(count, 0.0);

  // The field itself is smoothed over every neighbour first, which takes the
  // one-node islands and pinholes out of the coast before it is drawn.
  for (std::int32_t pass = 0; pass < p.smoothing; ++pass) {
    for (std::int32_t node = 0; node < nodes; ++node) {
      double sum = 0.0;
      std::int32_t around = 0;
      for (std::int32_t link = offsets_csr[node]; link < offsets_csr[node + 1]; ++link) {
        sum += field[static_cast<std::size_t>(neighbors[link])];
        ++around;
      }
      const double here = field[static_cast<std::size_t>(node)];
      next[static_cast<std::size_t>(node)] = around > 0 ? 0.5 * here + 0.5 * (sum / around) : here;
    }
    field.swap(next);
  }

  // The sea level that leaves `land` of the nodes dry: between the value
  // ranked just below the shore and the one ranked just above it.
  const auto drowned =
      static_cast<std::size_t>(std::lround((1.0 - p.land) * static_cast<double>(nodes)));
  double sea = 0.0;
  double top = 0.0;
  {
    std::vector<double> ranked(field);
    top = *std::max_element(ranked.begin(), ranked.end());
    if (drowned >= count) {
      sea = top + 1.0;
    } else if (drowned == 0) {
      sea = *std::min_element(ranked.begin(), ranked.end()) - 1.0;
    } else {
      std::nth_element(ranked.begin(), ranked.begin() + static_cast<std::ptrdiff_t>(drowned),
                       ranked.end());
      const double above = ranked[drowned];
      const double below =
          *std::max_element(ranked.begin(), ranked.begin() + static_cast<std::ptrdiff_t>(drowned));
      sea = 0.5 * (above + below);
    }
  }

  // Land rises from a low shore — so a beach is walkable from the sea — over
  // the first stretch inland, and from there stands as high as the relief
  // field says: hills and ridges wherever they fall, not one peak a continent.
  // The shore is 8% of the ceiling: low enough to walk up from the water,
  // and clear of the sea's surface, which the renderer draws a little above
  // sea level (WATER_LIFT in src/engine/renderer.ts), so dry land never
  // looks drowned.
  constexpr double kShore = 0.08;
  constexpr double kCoastRamp = 0.3;
  const auto relief_quarters = static_cast<std::int32_t>(std::lround(p.relief * 4.0));
  const double span = top - sea;
  std::vector<double> heights(count, 0.0);
  std::int32_t land = 0;
  for (std::size_t node = 0; node < count; ++node) {
    const double value = field[node];
    if (!(value > sea)) {
      continue;
    }
    const double inland = span > 0.0 ? std::min(1.0, (value - sea) / (kCoastRamp * span)) : 1.0;
    const double x = inland * relief_field[node];
    const double rise = p.peak > kShore ? p.peak - kShore : 0.0;
    heights[node] = ceiling * (kShore + rise * quarter_power(x, relief_quarters));
    ++land;
  }

  // Smoothed again over land neighbours only: the sea stays exactly at its
  // level and the land never sinks into it.
  for (std::int32_t pass = 0; pass < p.smoothing; ++pass) {
    for (std::int32_t node = 0; node < nodes; ++node) {
      const double here = heights[static_cast<std::size_t>(node)];
      if (!(here > 0.0)) {
        next[static_cast<std::size_t>(node)] = 0.0;
        continue;
      }
      double sum = 0.0;
      std::int32_t around = 0;
      for (std::int32_t link = offsets_csr[node]; link < offsets_csr[node + 1]; ++link) {
        const double other = heights[static_cast<std::size_t>(neighbors[link])];
        if (other > 0.0) {
          sum += other;
          ++around;
        }
      }
      next[static_cast<std::size_t>(node)] = around > 0 ? 0.5 * here + 0.5 * (sum / around) : here;
    }
    heights.swap(next);
  }

  float* out = grid.heights();
  const auto cap = static_cast<float>(ceiling);
  for (std::size_t node = 0; node < count; ++node) {
    const auto height = static_cast<float>(heights[node]);
    out[node] = height > cap ? cap : height;
  }
  return land;
}

}  // namespace inkulous
