#include "1inkulous/huts.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

namespace inkulous {
namespace {

// Footprint samples round the centre, on the wall and halfway in. They catch
// a pond corner or a ridge the nodes alone, a cell apart, can step over.
constexpr int kSiteRingSamples = 8;

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

// Projects `v` onto the plane tangent at unit `n` and normalises it. False
// when `v` points along `n`.
bool tangent_of(const double n[3], const double v[3], double out[3]) {
  const double along = dot3(v, n);
  out[0] = v[0] - n[0] * along;
  out[1] = v[1] - n[1] * along;
  out[2] = v[2] - n[2] * along;
  return normalize3(out);
}

// Any orthonormal pair tangent at unit `n`.
void tangent_basis(const double n[3], double e1[3], double e2[3]) {
  const double helper[3] = {std::fabs(n[1]) < 0.9 ? 0.0 : 1.0,
                            std::fabs(n[1]) < 0.9 ? 1.0 : 0.0, 0.0};
  tangent_of(n, helper, e1);
  e2[0] = n[1] * e1[2] - n[2] * e1[1];
  e2[1] = n[2] * e1[0] - n[0] * e1[2];
  e2[2] = n[0] * e1[1] - n[1] * e1[0];
}

// The point `angle` radians from unit `from` along unit tangent `tangent`.
void rotate_along(const double from[3], const double tangent[3], double angle, double out[3]) {
  const double c = std::cos(angle);
  const double s = std::sin(angle);
  out[0] = from[0] * c + tangent[0] * s;
  out[1] = from[1] * c + tangent[1] * s;
  out[2] = from[2] * c + tangent[2] * s;
  normalize3(out);
}

}  // namespace

void HutSet::collect_footprint(std::int32_t node) {
  footprint_scratch_.clear();
  footprint_scratch_.push_back(node);
  const std::int32_t* offsets = grid_->neighbor_offsets();
  const std::int32_t* neighbors = grid_->neighbors();
  for (std::int32_t link = offsets[node]; link < offsets[node + 1]; ++link) {
    footprint_scratch_.push_back(neighbors[link]);
  }
}

HutSite HutSet::judge(const double centre[3], std::int32_t node) const {
  float lowest = 0.0f;
  float highest = 0.0f;
  bool any = false;
  const auto take = [&](float height) {
    lowest = any ? std::min(lowest, height) : height;
    highest = any ? std::max(highest, height) : height;
    any = true;
  };

  for (const std::int32_t at : footprint_scratch_) {
    if (!grid_->dry(at)) {
      return HutSite::kWater;
    }
    take(grid_->height(at));
  }

  // The ground under the walls and halfway in. Inside the footprint this is
  // the nodes again; where the grid is fine enough that the walls reach past
  // them, it is the ground the mesh would stand on. Off the mesh is the edge
  // of an open patch, which the closed planet has none of.
  double e1[3];
  double e2[3];
  tangent_basis(centre, e1, e2);
  const double radius = grid_->planet_radius();
  const double rings[2] = {kHutRadius / radius, kHutRadius * 0.5 / radius};
  for (const double ring : rings) {
    for (int k = 0; k < kSiteRingSamples; ++k) {
      const double theta = (static_cast<double>(k) / kSiteRingSamples) * 6.283185307179586;
      const double tangent[3] = {e1[0] * std::cos(theta) + e2[0] * std::sin(theta),
                                 e1[1] * std::cos(theta) + e2[1] * std::sin(theta),
                                 e1[2] * std::cos(theta) + e2[2] * std::sin(theta)};
      double p[3];
      rotate_along(centre, tangent, ring, p);
      const std::int32_t under = grid_->locate(p, node);
      if (under < 0) {
        return HutSite::kWater;
      }
      SurfacePoint ground;
      grid_->sample(p, under, ground);
      if (!ground.on_mesh || ground.height <= kWaterHeight) {
        return HutSite::kWater;
      }
      take(static_cast<float>(ground.height));
    }
  }

  if (highest - lowest > kHutMaxUnevenness) {
    return HutSite::kUneven;
  }

  // Taken, or touching ground that is: the lane between two huts is at least
  // a node wide.
  const std::int32_t* offsets = grid_->neighbor_offsets();
  const std::int32_t* neighbors = grid_->neighbors();
  for (const std::int32_t at : footprint_scratch_) {
    if (grid_->blocked(at)) {
      return HutSite::kOccupied;
    }
    for (std::int32_t link = offsets[at]; link < offsets[at + 1]; ++link) {
      if (grid_->blocked(neighbors[link])) {
        return HutSite::kOccupied;
      }
    }
  }
  return HutSite::kOk;
}

HutSite HutSet::check_site(double x, double y, double z) {
  for (float& v : site_point_) {
    v = 0.0f;
  }
  if (grid_ == nullptr || !grid_->ready()) {
    return HutSite::kNoGrid;
  }
  sync_blocked();
  // Nearest node, not nearest walkable: a click on a standing hut is that
  // hut's anchor, and so occupied, not some free node beside it.
  const std::int32_t node = grid_->nearest_node(x, y, z);
  if (node < 0) {
    return HutSite::kNoGrid;
  }
  const float* d = grid_->direction(node);
  double centre[3] = {d[0], d[1], d[2]};
  normalize3(centre);

  collect_footprint(node);
  double extent = 0.0;
  for (const std::int32_t at : footprint_scratch_) {
    const float* a = grid_->direction(at);
    const double other[3] = {a[0], a[1], a[2]};
    extent = std::max(extent, angle_between(centre, other));
  }
  site_point_[0] = static_cast<float>(centre[0]);
  site_point_[1] = static_cast<float>(centre[1]);
  site_point_[2] = static_cast<float>(centre[2]);
  site_point_[3] = static_cast<float>(extent);

  const HutSite site = judge(centre, node);
  if (site != HutSite::kOk) {
    return site;
  }
  if (count() >= kMaxHuts) {
    return HutSite::kFull;
  }
  return HutSite::kOk;
}

std::int32_t HutSet::place(double x,
                           double y,
                           double z,
                           double hx,
                           double hy,
                           double hz,
                           std::int32_t tribe) {
  if (check_site(x, y, z) != HutSite::kOk) {
    return -1;
  }

  Hut hut;
  hut.node = footprint_scratch_.front();
  hut.footprint = footprint_scratch_;
  const float* d = grid_->direction(hut.node);
  hut.dir[0] = d[0];
  hut.dir[1] = d[1];
  hut.dir[2] = d[2];
  normalize3(hut.dir);
  hut.tribe = tribe < 0 ? -1 : tribe;

  const double wanted[3] = {hx, hy, hz};
  if (!tangent_of(hut.dir, wanted, hut.heading)) {
    double e2[3];
    tangent_basis(hut.dir, hut.heading, e2);
  }

  // The door is a body's width past the furthest footprint node; arrival is
  // anywhere out to the ring of free nodes round the pad, and a little more,
  // so a group packed round the door all count as there.
  const double radius = grid_->planet_radius();
  const double extent = static_cast<double>(site_point_[3]);
  double ring = extent;
  const std::int32_t* offsets = grid_->neighbor_offsets();
  const std::int32_t* neighbors = grid_->neighbors();
  for (const std::int32_t at : hut.footprint) {
    for (std::int32_t link = offsets[at]; link < offsets[at + 1]; ++link) {
      const float* a = grid_->direction(neighbors[link]);
      const double other[3] = {a[0], a[1], a[2]};
      ring = std::max(ring, angle_between(hut.dir, other));
    }
  }
  hut.door = extent + kFollowerSpacing / radius;
  hut.reach = ring + kFollowerSpacing * 1.5 / radius;

  huts_.push_back(std::move(hut));
  mark(huts_.back(), true);
  if (followers_ != nullptr) {
    followers_->step_off_blocked();
  }
  refresh_instances();
  return count() - 1;
}

void HutSet::mark(const Hut& hut, bool blocked) {
  const std::int32_t nodes = grid_ != nullptr ? grid_->node_count() : 0;
  for (const std::int32_t at : hut.footprint) {
    if (at >= 0 && at < nodes) {
      grid_->set_blocked(at, blocked);
    }
  }
}

void HutSet::sync_blocked() {
  if (grid_ == nullptr || grid_->topology_generation() == marked_generation_) {
    return;
  }
  marked_generation_ = grid_->topology_generation();
  for (const Hut& hut : huts_) {
    mark(hut, true);
  }
}

void HutSet::clear() {
  if (grid_ != nullptr && grid_->topology_generation() == marked_generation_) {
    for (const Hut& hut : huts_) {
      mark(hut, false);
    }
  }
  huts_.clear();
  instances_.clear();
  if (followers_ != nullptr) {
    followers_->clear_huts();
  }
}

std::int32_t HutSet::occupants(std::int32_t id) const {
  if (id < 0 || id >= count()) {
    return -1;
  }
  return huts_[static_cast<std::size_t>(id)].occupants;
}

std::int32_t HutSet::tribe(std::int32_t id) const {
  if (id < 0 || id >= count()) {
    return -1;
  }
  return huts_[static_cast<std::size_t>(id)].tribe;
}

std::int32_t HutSet::housed() const {
  std::int32_t total = 0;
  for (const Hut& hut : huts_) {
    total += hut.occupants;
  }
  return total;
}

std::int32_t HutSet::incoming(std::int32_t id) const {
  std::int32_t total = 0;
  for (std::int32_t f = 0; f < followers_->count(); ++f) {
    if (followers_->hut(f) == id) {
      ++total;
    }
  }
  return total;
}

std::int32_t HutSet::order_enter_selected(std::int32_t id) {
  if (followers_ == nullptr || grid_ == nullptr || !grid_->ready() || id < 0 || id >= count()) {
    return 0;
  }
  Hut& hut = huts_[static_cast<std::size_t>(id)];

  const std::int32_t room = kHutCapacity - hut.occupants - incoming(id);
  if (room <= 0) {
    return 0;
  }

  // Selected followers not already on their way in, nearest first.
  std::vector<std::pair<double, std::int32_t>> candidates;
  for (std::int32_t f = 0; f < followers_->count(); ++f) {
    // The shaman stays out: she has spells to cast, not children to raise.
    if (!followers_->selected(f) || followers_->hut(f) == id || followers_->is_shaman(f)) {
      continue;
    }
    candidates.emplace_back(angle_between(followers_->direction(f), hut.dir), f);
  }
  if (candidates.empty()) {
    return 0;
  }
  std::sort(candidates.begin(), candidates.end());

  // Claimed now, not on arrival, so a second order before anyone gets there
  // still fills it with one tribe.
  if (hut.tribe < 0) {
    hut.tribe = followers_->tribe(candidates.front().second);
  }

  std::vector<std::int32_t> chosen;
  for (const auto& candidate : candidates) {
    if (static_cast<std::int32_t>(chosen.size()) >= room) {
      break;
    }
    if (followers_->tribe(candidate.second) == hut.tribe) {
      chosen.push_back(candidate.second);
    }
  }
  if (chosen.empty()) {
    return 0;
  }

  // An ordinary move to the door — the formation packs round it, inside entry
  // reach, and the route goes round the pad to get there — and then the hut
  // is remembered. The move clears any hut they were heading for before, so
  // it has to go first.
  double door[3];
  door_point(hut, door);
  followers_->order_move(chosen, door[0], door[1], door[2]);
  for (const std::int32_t f : chosen) {
    followers_->set_hut(f, id);
  }
  refresh_instances();
  return static_cast<std::int32_t>(chosen.size());
}

void HutSet::door_point(const Hut& hut, double out[3]) const {
  rotate_along(hut.dir, hut.heading, hut.door, out);
}

void HutSet::admit_arrivals() {
  bool changed = false;

  // From the top down: going inside removes the follower, which shifts every
  // id above it.
  for (std::int32_t f = followers_->count() - 1; f >= 0; --f) {
    const std::int32_t id = followers_->hut(f);
    if (id < 0) {
      continue;
    }
    if (id >= count()) {
      followers_->set_hut(f, -1);
      continue;
    }

    Hut& hut = huts_[static_cast<std::size_t>(id)];
    if (angle_between(followers_->direction(f), hut.dir) <= hut.reach) {
      if (hut.occupants < kHutCapacity &&
          (hut.tribe < 0 || hut.tribe == followers_->tribe(f))) {
        hut.tribe = followers_->tribe(f);
        hut.occupants += 1;
        followers_->remove(f);
        changed = true;
      } else {
        // Filled up by someone else on the way. It stays at the door.
        followers_->set_hut(f, -1);
      }
      continue;
    }

    // Stopped short — no way in, or it gave up — so the order is over.
    if (!followers_->is_walking(f)) {
      followers_->set_hut(f, -1);
    }
  }

  if (changed) {
    refresh_instances();
  }
}

void HutSet::breed(double dt_seconds) {
  bool changed = false;

  for (Hut& hut : huts_) {
    if (hut.occupants <= 0 || hut.tribe < 0) {
      hut.breeding = 0.0;
      continue;
    }

    hut.breeding += dt_seconds * static_cast<double>(hut.occupants) / kHutBreedSeconds;
    while (hut.breeding >= 1.0) {
      double step_out[3];
      door_point(hut, step_out);
      if (followers_->spawn_at(step_out, hut.tribe) < 0) {
        // No room in the world, or no ground at the door. Hold the birth and
        // try again next step rather than piling them up.
        hut.breeding = 1.0;
        break;
      }
      hut.breeding -= 1.0;
      changed = true;
    }
  }

  if (changed) {
    refresh_instances();
  }
}

void HutSet::step(double dt_seconds) {
  if (grid_ == nullptr || followers_ == nullptr || !grid_->ready() || !(dt_seconds > 0.0)) {
    return;
  }
  sync_blocked();
  admit_arrivals();
  breed(dt_seconds);
}

void HutSet::refresh_instances() {
  const std::size_t needed = huts_.size() * static_cast<std::size_t>(kHutInstanceFloats);
  if (instances_.size() != needed) {
    instances_.resize(needed);
  }

  const bool ground = grid_ != nullptr && grid_->ready();
  const double radius = grid_ != nullptr ? grid_->planet_radius() : 1.0;
  const std::int32_t nodes = grid_ != nullptr ? grid_->node_count() : 0;

  for (std::size_t i = 0; i < huts_.size(); ++i) {
    const Hut& hut = huts_[i];
    // The anchor's height, read live: a stroke that raises the node raises
    // the hut on the next refresh.
    const double height =
        ground && hut.node >= 0 && hut.node < nodes ? grid_->height(hut.node) : 0.0;

    float* out = &instances_[i * static_cast<std::size_t>(kHutInstanceFloats)];
    const double r = radius + height;
    out[0] = static_cast<float>(hut.dir[0] * r);
    out[1] = static_cast<float>(hut.dir[1] * r);
    out[2] = static_cast<float>(hut.dir[2] * r);
    out[3] = static_cast<float>(hut.heading[0]);
    out[4] = static_cast<float>(hut.heading[1]);
    out[5] = static_cast<float>(hut.heading[2]);
    out[6] = static_cast<float>(hut.tribe);
    out[7] = static_cast<float>(hut.occupants);
  }
}

}  // namespace inkulous
