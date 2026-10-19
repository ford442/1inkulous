#include "1inkulous/shaman.hpp"

#include <algorithm>
#include <cmath>

namespace inkulous {
namespace {

double dot3(const double a[3], const double b[3]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

bool normalize3(double v[3]) {
  const double length = std::sqrt(dot3(v, v));
  if (!(length > 1e-12)) {
    return false;
  }
  v[0] /= length;
  v[1] /= length;
  v[2] /= length;
  return true;
}

double angle_between(const double a[3], const double b[3]) {
  const double d = dot3(a, b);
  return std::acos(d < -1.0 ? -1.0 : d > 1.0 ? 1.0 : d);
}

// The point a fraction `t` of the way along the great circle from unit `a` to
// unit `b`, which are `theta` radians apart.
void slerp(const double a[3], const double b[3], double theta, double t, double out[3]) {
  if (theta < 1e-9) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return;
  }
  const double s = std::sin(theta);
  const double wa = std::sin((1.0 - t) * theta) / s;
  const double wb = std::sin(t * theta) / s;
  out[0] = a[0] * wa + b[0] * wb;
  out[1] = a[1] * wa + b[1] * wb;
  out[2] = a[2] * wa + b[2] * wb;
  normalize3(out);
}

bool valid_tribe(std::int32_t tribe) { return tribe >= 0 && tribe < kMaxTribes; }

}  // namespace

std::int32_t Shamans::spawn(double x, double y, double z, std::int32_t tribe) {
  if (followers_ == nullptr || !valid_tribe(tribe) || followers_->shaman(tribe) >= 0) {
    return -1;
  }
  const std::int32_t id = followers_->spawn(x, y, z, tribe);
  if (id >= 0) {
    followers_->make_shaman(id);
  }
  return id;
}

double Shamans::mana(std::int32_t tribe) const {
  return valid_tribe(tribe) ? mana_[static_cast<std::size_t>(tribe)] : 0.0;
}

void Shamans::set_mana(std::int32_t tribe, double mana) {
  if (!valid_tribe(tribe) || !std::isfinite(mana)) {
    return;
  }
  mana_[static_cast<std::size_t>(tribe)] = std::clamp(mana, 0.0, kMaxMana);
}

double Shamans::income(std::int32_t tribe) const {
  return static_cast<double>(population(tribe)) * kManaPerPersonSecond;
}

std::int32_t Shamans::population(std::int32_t tribe) const {
  return valid_tribe(tribe) ? population_[static_cast<std::size_t>(tribe)] : 0;
}

double Shamans::stamp_angle() const {
  const double radius = grid_ != nullptr ? grid_->planet_radius() : 1.0;
  return kLandBridgeHalfWidth / radius;
}

LandBridge Shamans::check_land_bridge(std::int32_t tribe, const double a[3], const double b[3]) {
  return plan(tribe, a, b, false);
}

LandBridge Shamans::cast_land_bridge(std::int32_t tribe, const double a[3], const double b[3]) {
  return plan(tribe, a, b, true);
}

bool Shamans::wet(const double dir[3]) const {
  const std::int32_t node = grid_->nearest_node(dir[0], dir[1], dir[2]);
  if (node < 0) {
    return true;
  }
  SurfacePoint ground;
  grid_->sample(dir, node, ground);
  if (!ground.on_mesh) {
    return true;
  }
  // The same weight threshold routes are held to: a corner that would stop a
  // route standing here is a corner the bridge has to cover.
  for (int corner = 0; corner < 3; ++corner) {
    if (ground.nodes[corner] >= 0 && ground.weights[corner] > kRouteSupport &&
        !grid_->walkable(ground.nodes[corner])) {
      return true;
    }
  }
  return false;
}

bool Shamans::shore_near(const double dir[3], double out[3]) const {
  const std::int32_t node = grid_->nearest_walkable_node(dir[0], dir[1], dir[2]);
  if (node < 0) {
    return false;
  }
  const float* d = grid_->direction(node);
  out[0] = d[0];
  out[1] = d[1];
  out[2] = d[2];
  normalize3(out);
  return angle_between(dir, out) * grid_->planet_radius() <= kLandBridgeShoreReach;
}

LandBridge Shamans::plan(std::int32_t tribe, const double a_in[3], const double b_in[3], bool commit) {
  if (commit) {
    stamps_.clear();
  }
  if (grid_ == nullptr || followers_ == nullptr || !grid_->ready()) {
    return LandBridge::kNoGrid;
  }
  double a[3] = {a_in[0], a_in[1], a_in[2]};
  double b[3] = {b_in[0], b_in[1], b_in[2]};
  if (!normalize3(a) || !normalize3(b)) {
    return LandBridge::kNoGrid;
  }
  if (!valid_tribe(tribe)) {
    return LandBridge::kNoShaman;
  }
  const std::int32_t shaman = followers_->shaman(tribe);
  if (shaman < 0) {
    return LandBridge::kNoShaman;
  }

  // She has to be able to reach both ends from where she stands.
  const double radius = grid_->planet_radius();
  const double* at = followers_->direction(shaman);
  if (angle_between(at, a) * radius > kLandBridgeRange ||
      angle_between(at, b) * radius > kLandBridgeRange) {
    return LandBridge::kOutOfRange;
  }

  // A wet end within reach of a beach is pulled onto it, so the bridge lands
  // instead of stopping a few steps short. One dry or beached end is enough:
  // a pier is a bridge too. Two ends out at sea are not.
  double shore[3];
  const bool a_wet = wet(a);
  const bool b_wet = wet(b);
  const bool a_ashore = !a_wet || shore_near(a, shore);
  if (a_wet && a_ashore) {
    a[0] = shore[0];
    a[1] = shore[1];
    a[2] = shore[2];
  }
  const bool b_ashore = !b_wet || shore_near(b, shore);
  if (b_wet && b_ashore) {
    b[0] = shore[0];
    b[1] = shore[1];
    b[2] = shore[2];
  }
  if (!a_ashore && !b_ashore) {
    return LandBridge::kNoShore;
  }

  // Walk the line a fraction of a cell at a time looking for water. A line
  // the graph already crosses on dry ground would cost mana and raise nothing.
  const double theta = angle_between(a, b);
  const double sample_step = std::max(grid_->min_link_angle() * 0.5, 1e-4);
  const std::int32_t samples = std::max(1, static_cast<std::int32_t>(std::ceil(theta / sample_step)));
  bool needs_land = false;
  for (std::int32_t i = 0; i <= samples && !needs_land; ++i) {
    double p[3];
    slerp(a, b, theta, static_cast<double>(i) / samples, p);
    needs_land = wet(p);
  }
  if (!needs_land) {
    return LandBridge::kDry;
  }

  double& purse = mana_[static_cast<std::size_t>(tribe)];
  if (purse < kLandBridgeCost) {
    return LandBridge::kNoMana;
  }
  if (!commit) {
    return LandBridge::kOk;
  }
  purse -= kLandBridgeCost;

  // Stamps half a radius apart, so their falloffs overlap into one ridge
  // instead of a row of hummocks.
  const double spacing = stamp_angle() * 0.5;
  std::int32_t segments = std::max(1, static_cast<std::int32_t>(std::ceil(theta / spacing)));
  segments = std::min(segments, kMaxLandBridgeStamps - 1);
  stamps_.reserve(static_cast<std::size_t>(segments + 1) * 3);
  for (std::int32_t i = 0; i <= segments; ++i) {
    double p[3];
    slerp(a, b, theta, static_cast<double>(i) / segments, p);
    stamps_.push_back(static_cast<float>(p[0]));
    stamps_.push_back(static_cast<float>(p[1]));
    stamps_.push_back(static_cast<float>(p[2]));
  }
  return LandBridge::kOk;
}

void Shamans::count_population() {
  population_.fill(0);
  if (followers_ != nullptr) {
    for (std::int32_t f = 0; f < followers_->count(); ++f) {
      const std::int32_t tribe = followers_->tribe(f);
      if (valid_tribe(tribe)) {
        ++population_[static_cast<std::size_t>(tribe)];
      }
    }
  }
  if (huts_ != nullptr) {
    for (std::int32_t h = 0; h < huts_->count(); ++h) {
      const std::int32_t tribe = huts_->tribe(h);
      if (valid_tribe(tribe)) {
        population_[static_cast<std::size_t>(tribe)] += huts_->occupants(h);
      }
    }
  }
}

void Shamans::step(double dt_seconds) {
  count_population();
  for (std::size_t tribe = 0; tribe < mana_.size(); ++tribe) {
    mana_[tribe] = std::min(
        kMaxMana, mana_[tribe] + population_[tribe] * kManaPerPersonSecond * dt_seconds);
  }
}

void Shamans::clear() {
  mana_.fill(0.0);
  population_.fill(0);
  stamps_.clear();
}

}  // namespace inkulous
