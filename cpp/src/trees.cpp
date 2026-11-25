#include "1inkulous/trees.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

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

// Any orthonormal pair tangent at unit `n`.
void tangent_basis(const double n[3], double e1[3], double e2[3]) {
  const double helper[3] = {std::fabs(n[1]) < 0.9 ? 0.0 : 1.0, std::fabs(n[1]) < 0.9 ? 1.0 : 0.0,
                            0.0};
  const double along = dot3(helper, n);
  e1[0] = helper[0] - n[0] * along;
  e1[1] = helper[1] - n[1] * along;
  e1[2] = helper[2] - n[2] * along;
  normalize3(e1);
  e2[0] = n[1] * e1[2] - n[2] * e1[1];
  e2[1] = n[2] * e1[0] - n[0] * e1[2];
  e2[2] = n[0] * e1[1] - n[1] * e1[0];
}

// `from` carried `angle` radians along the unit tangent `tangent`.
void rotate_along(const double from[3], const double tangent[3], double angle, double out[3]) {
  const double c = std::cos(angle);
  const double s = std::sin(angle);
  out[0] = from[0] * c + tangent[0] * s;
  out[1] = from[1] * c + tangent[1] * s;
  out[2] = from[2] * c + tangent[2] * s;
  normalize3(out);
}

// Unit tangent at `from` towards `to`; false when they coincide.
bool tangent_towards(const double from[3], const double to[3], double out[3]) {
  const double along = dot3(to, from);
  out[0] = to[0] - from[0] * along;
  out[1] = to[1] - from[1] * along;
  out[2] = to[2] - from[2] * along;
  return normalize3(out);
}

}  // namespace

std::int32_t TreeSet::spawn(std::int32_t how_many, MatchRandom& random) {
  clear();
  if (grid_ == nullptr || !grid_->ready() || how_many <= 0) {
    return 0;
  }
  const std::int32_t nodes = grid_->node_count();
  const std::int32_t* offsets = grid_->neighbor_offsets();
  const std::int32_t* neighbors = grid_->neighbors();

  // Dry land above the shore: walkable, and with no water next door.
  std::vector<std::int32_t> candidates;
  for (std::int32_t node = 0; node < nodes; ++node) {
    if (!grid_->walkable(node)) {
      continue;
    }
    bool inland = true;
    for (std::int32_t link = offsets[node]; link < offsets[node + 1] && inland; ++link) {
      inland = grid_->dry(neighbors[link]);
    }
    if (inland) {
      candidates.push_back(node);
    }
  }

  // A shuffle drawn from the match's generator, then first come first
  // planted, keeping every tree a node clear of the last so the forest is
  // scattered rather than solid.
  for (std::size_t i = candidates.size(); i > 1; --i) {
    const std::size_t j = random.next() % i;
    std::swap(candidates[i - 1], candidates[j]);
  }
  const std::int32_t wanted = std::min(how_many, kMaxTrees);
  std::vector<std::uint8_t> taken(static_cast<std::size_t>(nodes), 0);
  for (const std::int32_t node : candidates) {
    if (static_cast<std::int32_t>(trees_.size()) >= wanted) {
      break;
    }
    if (taken[static_cast<std::size_t>(node)] != 0) {
      continue;
    }
    taken[static_cast<std::size_t>(node)] = 1;
    for (std::int32_t link = offsets[node]; link < offsets[node + 1]; ++link) {
      taken[static_cast<std::size_t>(neighbors[link])] = 1;
    }

    Tree tree;
    tree.node = node;
    const float* d = grid_->direction(node);
    tree.dir[0] = d[0];
    tree.dir[1] = d[1];
    tree.dir[2] = d[2];
    normalize3(tree.dir);
    double e1[3];
    double e2[3];
    tangent_basis(tree.dir, e1, e2);
    const double turn = random.unit() * 6.283185307179586;
    for (int k = 0; k < 3; ++k) {
      tree.heading[k] = e1[k] * std::cos(turn) + e2[k] * std::sin(turn);
    }
    tree.size = 0.8 + 0.4 * random.unit();
    trees_.push_back(tree);
  }

  refresh_instances();
  return count();
}

std::int32_t TreeSet::plant(double x, double y, double z) {
  if (grid_ == nullptr || !grid_->ready() || count() >= kMaxTrees) {
    return -1;
  }
  const std::int32_t node = grid_->nearest_walkable_node(x, y, z);
  if (node < 0) {
    return -1;
  }
  for (const Tree& standing : trees_) {
    if (standing.node == node) {
      return -1;
    }
  }
  Tree tree;
  tree.node = node;
  const float* d = grid_->direction(node);
  tree.dir[0] = d[0];
  tree.dir[1] = d[1];
  tree.dir[2] = d[2];
  normalize3(tree.dir);
  double side[3];
  tangent_basis(tree.dir, tree.heading, side);
  trees_.push_back(tree);
  refresh_instances();
  return count() - 1;
}

void TreeSet::clear() {
  trees_.clear();
  instances_.clear();
  if (followers_ != nullptr) {
    followers_->clear_trees();
  }
}

double TreeSet::progress(std::int32_t id) const {
  if (id < 0 || id >= count()) {
    return -1.0;
  }
  return trees_[static_cast<std::size_t>(id)].progress;
}

bool TreeSet::lost(const Tree& tree) const {
  return tree.node < 0 || tree.node >= grid_->node_count() || !grid_->dry(tree.node) ||
         grid_->blocked(tree.node);
}

void TreeSet::remove(std::int32_t id) {
  trees_.erase(trees_.begin() + id);
  if (followers_ != nullptr) {
    followers_->tree_removed(id);
  }
}

std::int32_t TreeSet::incoming(std::int32_t id) const {
  std::int32_t total = 0;
  for (std::int32_t f = 0; f < followers_->count(); ++f) {
    if (followers_->tree(f) == id) {
      ++total;
    }
  }
  return total;
}

std::int32_t TreeSet::order_chop_selected(std::int32_t id) {
  if (followers_ == nullptr) {
    return 0;
  }
  std::vector<std::int32_t> ids;
  for (std::int32_t f = 0; f < followers_->count(); ++f) {
    if (followers_->selected(f)) {
      ids.push_back(f);
    }
  }
  return order_chop(ids, id);
}

std::int32_t TreeSet::order_chop(const std::vector<std::int32_t>& ids, std::int32_t id) {
  if (followers_ == nullptr || grid_ == nullptr || !grid_->ready() || id < 0 || id >= count()) {
    return 0;
  }
  const Tree& tree = trees_[static_cast<std::size_t>(id)];
  const std::int32_t room = kChoppersPerTree - incoming(id);
  if (room <= 0) {
    return 0;
  }

  // Braves not already at this tree, nearest first. Warriors have better
  // things to do, and the shaman has spells.
  std::vector<std::pair<double, std::int32_t>> candidates;
  for (const std::int32_t f : ids) {
    if (!followers_->takes_orders(f) || !followers_->is_brave(f) || followers_->is_shaman(f) ||
        followers_->tree(f) == id) {
      continue;
    }
    candidates.emplace_back(angle_between(followers_->direction(f), tree.dir), f);
  }
  std::sort(candidates.begin(), candidates.end());
  std::vector<std::int32_t> chosen;
  for (const auto& candidate : candidates) {
    if (static_cast<std::int32_t>(chosen.size()) >= room) {
      break;
    }
    chosen.push_back(candidate.second);
  }
  if (chosen.empty()) {
    return 0;
  }

  // Each one gets its own spot round the trunk, a spacing out and a third
  // of a turn from the last, the first facing the way the nearest comes
  // from. A group order would pack them by the grid, which spreads them a
  // cell apart and out of reach of the tree. The move clears any tree or hut
  // they were bound for, so it goes first.
  const double stand = kFollowerSpacing / grid_->planet_radius();
  double toward[3];
  double side[3];
  if (!tangent_towards(tree.dir, followers_->direction(chosen.front()), toward)) {
    tangent_basis(tree.dir, toward, side);
  }
  side[0] = tree.dir[1] * toward[2] - tree.dir[2] * toward[1];
  side[1] = tree.dir[2] * toward[0] - tree.dir[0] * toward[2];
  side[2] = tree.dir[0] * toward[1] - tree.dir[1] * toward[0];
  const std::int32_t taken = kChoppersPerTree - room;
  std::vector<std::int32_t> one(1);
  for (std::size_t k = 0; k < chosen.size(); ++k) {
    const double turn = static_cast<double>(taken + static_cast<std::int32_t>(k)) *
                        6.283185307179586 / kChoppersPerTree;
    const double tangent[3] = {toward[0] * std::cos(turn) + side[0] * std::sin(turn),
                               toward[1] * std::cos(turn) + side[1] * std::sin(turn),
                               toward[2] * std::cos(turn) + side[2] * std::sin(turn)};
    double spot[3];
    rotate_along(tree.dir, tangent, stand, spot);
    one[0] = chosen[k];
    followers_->order_move(one, spot[0], spot[1], spot[2]);
    followers_->set_tree(chosen[k], id);
  }
  followers_->refresh_instances();
  return static_cast<std::int32_t>(chosen.size());
}

void TreeSet::step(double dt_seconds) {
  if (grid_ == nullptr || followers_ == nullptr || !grid_->ready() || !(dt_seconds > 0.0)) {
    return;
  }
  bool changed = false;

  // From the top, so removing one leaves the ids still to visit alone.
  for (std::int32_t id = count() - 1; id >= 0; --id) {
    if (lost(trees_[static_cast<std::size_t>(id)])) {
      remove(id);
      changed = true;
    }
  }

  const double radius = grid_->planet_radius();
  for (std::int32_t f = 0; f < followers_->count(); ++f) {
    const std::int32_t id = followers_->tree(f);
    if (id < 0) {
      continue;
    }
    if (id >= count()) {
      followers_->set_tree(f, -1);
      continue;
    }
    Tree& tree = trees_[static_cast<std::size_t>(id)];
    if (angle_between(followers_->direction(f), tree.dir) * radius <= kChopReach) {
      tree.progress += dt_seconds / kChopSeconds;
      changed = true;
      if (tree.progress >= 1.0) {
        // Whoever lands the last blow brings the wood home for their tribe.
        // Everyone else at this tree loses the order with it.
        if (stores_ != nullptr) {
          stores_->add_wood(followers_->tribe(f), kWoodPerTree);
        }
        remove(id);
      }
      continue;
    }
    // Stopped short — no way there, or it gave up — so the order is over.
    if (!followers_->is_walking(f)) {
      followers_->set_tree(f, -1);
    }
  }

  if (changed) {
    refresh_instances();
  }
}

void TreeSet::refresh_instances() {
  const std::size_t needed = trees_.size() * static_cast<std::size_t>(kTreeInstanceFloats);
  if (instances_.size() != needed) {
    instances_.resize(needed);
  }
  const bool ground = grid_ != nullptr && grid_->ready();
  const double radius = grid_ != nullptr ? grid_->planet_radius() : 1.0;
  const std::int32_t nodes = grid_ != nullptr ? grid_->node_count() : 0;

  for (std::size_t i = 0; i < trees_.size(); ++i) {
    const Tree& tree = trees_[i];
    // Read live, as huts do, so a tree rides a sculpt stroke.
    const double height =
        ground && tree.node >= 0 && tree.node < nodes ? grid_->height(tree.node) : 0.0;
    float* out = &instances_[i * static_cast<std::size_t>(kTreeInstanceFloats)];
    const double r = radius + height;
    out[0] = static_cast<float>(tree.dir[0] * r);
    out[1] = static_cast<float>(tree.dir[1] * r);
    out[2] = static_cast<float>(tree.dir[2] * r);
    out[3] = static_cast<float>(tree.heading[0]);
    out[4] = static_cast<float>(tree.heading[1]);
    out[5] = static_cast<float>(tree.heading[2]);
    out[6] = static_cast<float>(tree.size);
    out[7] = static_cast<float>(std::min(tree.progress, 1.0));
  }
}

}  // namespace inkulous
