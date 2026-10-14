#include "1inkulous/buildings.hpp"

#include <cmath>
#include <cstddef>
#include <utility>

namespace inkulous {

bool BuildingSet::collect_footprint(std::int32_t node, std::vector<std::int32_t>& footprint) const {
  footprint.clear();
  if (grid_ == nullptr || !grid_->ready() || node < 0 || node >= grid_->node_count()) {
    return false;
  }
  footprint.push_back(node);
  const std::int32_t* offsets = grid_->neighbor_offsets();
  const std::int32_t* neighbors = grid_->neighbors();
  for (std::int32_t link = offsets[node]; link < offsets[node + 1]; ++link) {
    footprint.push_back(neighbors[link]);
  }
  return true;
}

bool BuildingSet::linked_in_patch(std::int32_t from,
                                  std::int32_t to,
                                  const std::vector<std::int32_t>& footprint) const {
  for (const std::int32_t node : footprint) {
    if (node == to) {
      return from != to;
    }
  }
  return false;
}

BuildingSite BuildingSet::judge(const std::vector<std::int32_t>& footprint) const {
  for (const std::int32_t node : footprint) {
    if (!grid_->walkable(node)) {
      return BuildingSite::kWater;
    }
  }

  const std::int32_t* offsets = grid_->neighbor_offsets();
  const std::int32_t* neighbors = grid_->neighbors();
  for (const std::int32_t from : footprint) {
    for (std::int32_t link = offsets[from]; link < offsets[from + 1]; ++link) {
      const std::int32_t to = neighbors[link];
      if (!linked_in_patch(from, to, footprint)) {
        continue;
      }
      // One link, counted from both ends. The second visit sees the same slope.
      const double run = grid_->arc_length(from, to);
      const double climb =
          std::fabs(static_cast<double>(grid_->height(to)) - static_cast<double>(grid_->height(from)));
      if (run > 0.0 && climb > kBuildingMaxSlope * run) {
        return BuildingSite::kSteep;
      }
    }
  }

  for (const std::int32_t node : footprint) {
    if (node >= 0 && static_cast<std::size_t>(node) < node_owner_.size() && node_owner_[static_cast<std::size_t>(node)] >= 0) {
      return BuildingSite::kOccupied;
    }
  }
  return BuildingSite::kOk;
}

void BuildingSet::rebuild_owners() {
  const std::int32_t nodes = grid_ != nullptr ? grid_->node_count() : 0;
  node_owner_.assign(static_cast<std::size_t>(nodes > 0 ? nodes : 0), -1);
  if (nodes <= 0) {
    return;
  }
  for (std::int32_t id = 0; id < count(); ++id) {
    for (const std::int32_t node : buildings_[static_cast<std::size_t>(id)].footprint) {
      if (node >= 0 && node < nodes) {
        node_owner_[static_cast<std::size_t>(node)] = id;
      }
    }
  }
}

BuildingSite BuildingSet::check_site(double x, double y, double z) {
  if (grid_ == nullptr || !grid_->ready()) {
    return BuildingSite::kNoGrid;
  }
  const std::int32_t node = grid_->nearest_node(x, y, z);
  if (node < 0 || !collect_footprint(node, footprint_scratch_)) {
    return BuildingSite::kNoGrid;
  }
  if (static_cast<std::int32_t>(node_owner_.size()) != grid_->node_count()) {
    rebuild_owners();
  }
  const BuildingSite site = judge(footprint_scratch_);
  if (site != BuildingSite::kOk) {
    return site;
  }
  if (count() >= kMaxBuildings) {
    return BuildingSite::kFull;
  }
  return BuildingSite::kOk;
}

std::int32_t BuildingSet::place(double x, double y, double z, std::int32_t tribe, std::int32_t kind) {
  if (kind < 0) {
    return -1;
  }
  if (check_site(x, y, z) != BuildingSite::kOk) {
    return -1;
  }

  Building building;
  building.node = footprint_scratch_.front();
  building.tribe = tribe;
  building.kind = kind;
  building.footprint = footprint_scratch_;
  buildings_.push_back(std::move(building));
  const std::int32_t id = count() - 1;
  for (const std::int32_t node : buildings_.back().footprint) {
    if (node >= 0 && static_cast<std::size_t>(node) < node_owner_.size()) {
      node_owner_[static_cast<std::size_t>(node)] = id;
    }
  }
  refresh_instances();
  return id;
}

void BuildingSet::clear() {
  buildings_.clear();
  instances_.clear();
  node_owner_.assign(node_owner_.size(), -1);
}

bool BuildingSet::blocked(std::int32_t node) const {
  if (node < 0 || static_cast<std::size_t>(node) >= node_owner_.size()) {
    return false;
  }
  return node_owner_[static_cast<std::size_t>(node)] >= 0;
}

void BuildingSet::refresh_instances() {
  const std::size_t needed = buildings_.size() * static_cast<std::size_t>(kBuildingInstanceFloats);
  if (instances_.size() != needed) {
    instances_.resize(needed);
  }

  const bool ground = grid_ != nullptr && grid_->ready();
  const double radius = grid_ != nullptr ? grid_->planet_radius() : 1.0;
  const std::int32_t nodes = grid_ != nullptr ? grid_->node_count() : 0;

  for (std::size_t i = 0; i < buildings_.size(); ++i) {
    const Building& building = buildings_[i];
    float* out = &instances_[i * static_cast<std::size_t>(kBuildingInstanceFloats)];

    double dir_x = 0.0;
    double dir_y = 1.0;
    double dir_z = 0.0;
    double height = 0.0;
    if (ground && building.node >= 0 && building.node < nodes) {
      const float* dir = grid_->direction(building.node);
      dir_x = dir[0];
      dir_y = dir[1];
      dir_z = dir[2];
      // Live height of the anchor, same as an idle follower's feet: a stroke
      // that raises the node raises the hut on the next refresh.
      height = grid_->height(building.node);
    }

    const double r = radius + height;
    out[0] = static_cast<float>(dir_x * r);
    out[1] = static_cast<float>(dir_y * r);
    out[2] = static_cast<float>(dir_z * r);
    out[3] = static_cast<float>(building.tribe);
    out[4] = static_cast<float>(building.kind);
    out[5] = static_cast<float>(building.occupants);
    out[6] = static_cast<float>(building.flags);
    out[7] = 0.0f;
  }
}

}  // namespace inkulous
