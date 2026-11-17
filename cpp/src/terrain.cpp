#include "1inkulous/terrain.hpp"

#include <cmath>
#include <limits>

namespace inkulous {
namespace {

bool unit(const double in[3], double out[3]) {
  const double length = std::sqrt(in[0] * in[0] + in[1] * in[1] + in[2] * in[2]);
  if (!(length > 1e-12) || !std::isfinite(length)) {
    return false;
  }
  out[0] = in[0] / length;
  out[1] = in[1] / length;
  out[2] = in[2] / length;
  return true;
}

}  // namespace

void Terrain::set_max_height(double max_height) {
  max_height_ = std::isfinite(max_height) && max_height > 0.0 ? max_height : 0.0;
}

template <typename Step>
NodeRange Terrain::brush(const double centre[3], double angular_radius, bool commit, Step next) const {
  NodeRange moved;
  double c[3];
  if (grid_ == nullptr || !grid_->ready() || !(angular_radius > 0.0) || !unit(centre, c)) {
    return moved;
  }

  const double cos_radius = std::cos(angular_radius);
  float* heights = grid_->heights();
  const std::int32_t nodes = grid_->node_count();
  // A few thousand nodes: a straight scan is cheaper than asking the direction
  // hash for a disc, and visits nodes in id order so the result is
  // deterministic however the brush moves.
  for (std::int32_t node = 0; node < nodes; ++node) {
    const float* d = grid_->direction(node);
    const double dot = d[0] * c[0] + d[1] * c[1] + d[2] * c[2];
    if (dot <= cos_radius) {
      continue;
    }
    // Smooth falloff from full strength at the centre to nothing at the rim,
    // so strokes blend instead of leaving stepped craters.
    const double angle = std::acos(dot < 1.0 ? dot : 1.0);
    const double t = 1.0 - angle / angular_radius;
    const double falloff = t * t * (3.0 - 2.0 * t);

    const float before = heights[node];
    const float after = next(falloff, static_cast<double>(before));
    if (after != before) {
      if (commit) {
        heights[node] = after;
      }
      moved.include(node);
    }
  }
  return moved;
}

NodeRange Terrain::sculpt(const double centre[3], double angular_radius, double delta) {
  const NodeRange moved = sculpt_impl(centre, angular_radius, delta, true);
  dirty_.include(moved);
  return moved;
}

bool Terrain::would_sculpt(const double centre[3], double angular_radius, double delta) const {
  return !sculpt_impl(centre, angular_radius, delta, false).empty();
}

NodeRange Terrain::flatten(const double centre[3],
                           double angular_radius,
                           double target_height,
                           double rate) {
  const NodeRange moved = flatten_impl(centre, angular_radius, target_height, rate, true);
  dirty_.include(moved);
  return moved;
}

bool Terrain::would_flatten(const double centre[3],
                            double angular_radius,
                            double target_height,
                            double rate) const {
  return !flatten_impl(centre, angular_radius, target_height, rate, false).empty();
}

NodeRange Terrain::sculpt_impl(const double centre[3],
                               double angular_radius,
                               double delta,
                               bool commit) const {
  if (!(delta != 0.0) || !std::isfinite(delta)) {
    return NodeRange{};
  }
  // Heights are float32, so cap at the representable value — otherwise a
  // saturated node compares unequal to its own stored height and is reported
  // dirty on every stroke.
  const bool capped = max_height_ > 0.0;
  const float cap = capped ? static_cast<float>(max_height_) : std::numeric_limits<float>::max();
  const double scale = capped ? max_height_ : (grid_ != nullptr ? grid_->planet_radius() : 1.0);
  const double min_step = kMinStepFraction * scale;

  return brush(centre, angular_radius, commit, [&](double falloff, double before) -> float {
    const double step = delta * falloff;
    if (std::fabs(step) < min_step) {
      return static_cast<float>(before);
    }
    const double after = before + step;
    if (after <= 0.0) return 0.0f;
    if (after >= cap) return cap;
    return static_cast<float>(after);
  });
}

NodeRange Terrain::flatten_impl(const double centre[3],
                                double angular_radius,
                                double target_height,
                                double rate,
                                bool commit) const {
  if (!(rate > 0.0) || !std::isfinite(rate) || !std::isfinite(target_height)) {
    return NodeRange{};
  }
  // Stored as float32, so the target is too: a node that has arrived has to
  // compare equal to it, or the pad would stay dirty.
  double clamped = target_height < 0.0 ? 0.0 : target_height;
  if (max_height_ > 0.0 && clamped > max_height_) {
    clamped = max_height_;
  }
  const float target = static_cast<float>(clamped);

  return brush(centre, angular_radius, commit, [&](double falloff, double before) -> float {
    const double gap = static_cast<double>(target) - before;
    // Same falloff as sculpt, so the pad's edge blends into the slope round it
    // instead of stepping down a cliff.
    const double reach = rate * falloff;
    if (gap == 0.0 || !(reach > 0.0)) {
      return static_cast<float>(before);
    }
    if (std::fabs(gap) <= reach) {
      return target;
    }
    return static_cast<float>(before + (gap > 0.0 ? reach : -reach));
  });
}

double Terrain::height_at(const double dir[3]) const {
  if (grid_ == nullptr || !grid_->ready()) {
    return 0.0;
  }
  double q[3];
  if (!unit(dir, q)) {
    return 0.0;
  }
  const std::int32_t node = grid_->nearest_node(q[0], q[1], q[2]);
  if (node < 0) {
    return 0.0;
  }
  SurfacePoint ground;
  grid_->sample(q, node, ground);
  // Off the mesh only happens on an open test patch; the node's own height is
  // the honest answer there.
  return ground.on_mesh ? ground.height : grid_->height(node);
}

}  // namespace inkulous
