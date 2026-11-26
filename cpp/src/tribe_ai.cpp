#include "1inkulous/tribe_ai.hpp"

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
  const double d = dot3(a, b) / std::sqrt(dot3(a, a) * dot3(b, b));
  return std::acos(d < -1.0 ? -1.0 : d > 1.0 ? 1.0 : d);
}

void node_dir(const NavGrid& grid, std::int32_t node, double out[3]) {
  const float* d = grid.direction(node);
  out[0] = d[0];
  out[1] = d[1];
  out[2] = d[2];
  normalize3(out);
}

double clamp(double value, double low, double high, double fallback) {
  if (!std::isfinite(value)) {
    return fallback;
  }
  return value < low ? low : value > high ? high : value;
}

std::int32_t clamp_int(std::int32_t value, std::int32_t low, std::int32_t high) {
  return value < low ? low : value > high ? high : value;
}

}  // namespace

AiPersonality sanitized(const AiPersonality& in) {
  const AiPersonality defaults;
  AiPersonality out = in;
  // A tenth of a second is two steps: quicker than that is not thinking, it
  // is twitching.
  out.think_seconds = clamp(in.think_seconds, 0.1, 30.0, defaults.think_seconds);
  out.hut_cap = clamp_int(in.hut_cap, 0, kMaxHuts);
  out.build_reach = clamp(in.build_reach, 0.05, 2.0, defaults.build_reach);
  out.forage_reach = clamp(in.forage_reach, 0.05, 3.0, defaults.forage_reach);
  out.patch = clamp_int(in.patch, 0, kMaxFollowers);
  out.muster = clamp_int(in.muster, 1, kMaxFollowers);
  out.settle = clamp_int(in.settle, 0, kMaxFollowers);
  return out;
}

bool TribeAi::configure(std::int32_t tribe, const AiPersonality& personality) {
  if (!valid_tribe(tribe)) {
    return false;
  }
  personalities_[static_cast<std::size_t>(tribe)] = sanitized(personality);
  return true;
}

const AiPersonality& TribeAi::personality(std::int32_t tribe) const {
  static const AiPersonality kDefault;
  return valid_tribe(tribe) ? personalities_[static_cast<std::size_t>(tribe)] : kDefault;
}

bool TribeAi::enable(std::int32_t tribe) {
  if (!valid_tribe(tribe) || followers_ == nullptr || huts_ == nullptr) {
    return false;
  }
  Mind& mind = minds_[static_cast<std::size_t>(tribe)];
  const double* home = nullptr;
  for (std::int32_t h = 0; h < huts_->count() && home == nullptr; ++h) {
    if (huts_->tribe(h) == tribe) {
      home = huts_->direction(h);
    }
  }
  const std::int32_t shaman = followers_->shaman(tribe);
  if (home == nullptr && shaman >= 0) {
    home = followers_->direction(shaman);
  }
  if (home == nullptr) {
    return false;
  }
  mind = Mind{};
  mind.on = true;
  mind.wait = personality(tribe).think_seconds;
  mind.home[0] = home[0];
  mind.home[1] = home[1];
  mind.home[2] = home[2];
  normalize3(mind.home);
  return true;
}

void TribeAi::disable(std::int32_t tribe) {
  if (valid_tribe(tribe)) {
    minds_[static_cast<std::size_t>(tribe)].on = false;
  }
}

bool TribeAi::enabled(std::int32_t tribe) const {
  return valid_tribe(tribe) && minds_[static_cast<std::size_t>(tribe)].on;
}

AiAction TribeAi::last_action(std::int32_t tribe) const {
  return valid_tribe(tribe) ? minds_[static_cast<std::size_t>(tribe)].last : AiAction::kWait;
}

std::int32_t TribeAi::actions(std::int32_t tribe) const {
  return valid_tribe(tribe) ? minds_[static_cast<std::size_t>(tribe)].done : 0;
}

std::int32_t TribeAi::thinks(std::int32_t tribe) const {
  return valid_tribe(tribe) ? minds_[static_cast<std::size_t>(tribe)].thinks : 0;
}

void TribeAi::clear() {
  minds_.fill(Mind{});
  personalities_.fill(AiPersonality{});
}

void TribeAi::step(double dt_seconds) {
  if (grid_ == nullptr || !grid_->ready() || shamans_ == nullptr || shamans_->match_over()) {
    return;
  }
  for (std::int32_t tribe = 0; tribe < kMaxTribes; ++tribe) {
    Mind& mind = minds_[static_cast<std::size_t>(tribe)];
    if (!mind.on || followers_->fallen(tribe)) {
      continue;
    }
    mind.wait -= dt_seconds;
    if (mind.wait > 1e-9) {
      continue;
    }
    mind.wait += personality(tribe).think_seconds;
    mind.thinks += 1;
    mind.last = think(tribe, mind);
    if (mind.last != AiAction::kWait) {
      mind.done += 1;
    }
  }
}

AiAction TribeAi::think(std::int32_t tribe, Mind& mind) {
  if (shaman_idle(tribe)) {
    if (try_bridge(tribe)) {
      // try_bridge says which of the two it did by whether she is casting.
      return shamans_->casting(tribe) >= 0 ? AiAction::kCast : AiAction::kToShore;
    }
    if (try_patch_spell(tribe)) {
      return AiAction::kCast;
    }
  }
  const AiAction built = try_build(tribe, mind);
  if (built != AiAction::kWait) {
    return built;
  }
  if (try_settle(tribe)) {
    return AiAction::kSettle;
  }
  if (try_chop(tribe, mind)) {
    return AiAction::kChop;
  }
  if (try_train(tribe)) {
    return AiAction::kTrain;
  }
  if (try_attack(tribe, mind)) {
    return AiAction::kAttack;
  }
  return AiAction::kWait;
}

bool TribeAi::shaman_idle(std::int32_t tribe) const {
  const std::int32_t shaman = followers_->shaman(tribe);
  return shaman >= 0 && !followers_->casting(shaman) && !followers_->is_walking(shaman);
}

std::int32_t TribeAi::enemy_shaman(std::int32_t tribe, const double from[3]) const {
  std::int32_t best = -1;
  double nearest = 0.0;
  for (std::int32_t other = 0; other < kMaxTribes; ++other) {
    if (other == tribe) {
      continue;
    }
    const std::int32_t id = followers_->shaman(other);
    if (id < 0) {
      continue;
    }
    const double angle = angle_between(from, followers_->direction(id));
    if (best < 0 || angle < nearest) {
      best = id;
      nearest = angle;
    }
  }
  return best;
}

void TribeAi::flood(std::int32_t start) {
  const auto nodes = static_cast<std::size_t>(grid_->node_count());
  if (reach_stamp_.size() != nodes) {
    reach_stamp_.assign(nodes, 0);
    reach_generation_ = 0;
  }
  if (++reach_generation_ == 0) {
    std::fill(reach_stamp_.begin(), reach_stamp_.end(), 0);
    reach_generation_ = 1;
  }
  queue_.clear();
  if (start < 0 || !grid_->walkable(start)) {
    return;
  }
  const std::int32_t* offsets = grid_->neighbor_offsets();
  const std::int32_t* neighbors = grid_->neighbors();
  reach_stamp_[static_cast<std::size_t>(start)] = reach_generation_;
  queue_.push_back(start);
  for (std::size_t head = 0; head < queue_.size(); ++head) {
    const std::int32_t node = queue_[head];
    for (std::int32_t link = offsets[node]; link < offsets[node + 1]; ++link) {
      const std::int32_t next = neighbors[link];
      // The step routes take, diagonals and all: a pinched coast a diagonal
      // could slip across but no walker can is not a way through.
      if (reached(next) || !grid_->steppable(node, link)) {
        continue;
      }
      reach_stamp_[static_cast<std::size_t>(next)] = reach_generation_;
      queue_.push_back(next);
    }
  }
}

bool TribeAi::try_bridge(std::int32_t tribe) {
  if (!personality(tribe).bridges || !shamans_->unlocked(tribe, Spell::kLandBridge)) {
    return false;
  }
  // Only for warriors that cannot get there: the first one stands for the
  // group, since they are sent together.
  std::int32_t warrior = -1;
  for (std::int32_t f = 0; f < followers_->count() && warrior < 0; ++f) {
    if (followers_->tribe(f) == tribe && followers_->role(f) == Role::kWarrior) {
      warrior = f;
    }
  }
  if (warrior < 0) {
    return false;
  }
  const double* warrior_at = followers_->direction(warrior);
  const std::int32_t enemy = enemy_shaman(tribe, warrior_at);
  if (enemy < 0) {
    return false;
  }
  // Not able to pay, she does not go: no walk to the shore, no bridge.
  const SpellRules& rules = spell_rules(Spell::kLandBridge);
  if (shamans_->mana(tribe) < rules.cost || shamans_->cooldown(tribe, Spell::kLandBridge) > 0.0) {
    return false;
  }

  const double* w = warrior_at;
  flood(grid_->nearest_walkable_node(w[0], w[1], w[2]));
  const double* e = followers_->direction(enemy);
  const std::int32_t enemy_node = grid_->nearest_walkable_node(e[0], e[1], e[2]);
  if (reached(enemy_node)) {
    return false;  // A way round on foot: no gap to bridge.
  }

  // The warriors' shore: their landmass's nodes with water next door.
  const std::int32_t* offsets = grid_->neighbor_offsets();
  const std::int32_t* neighbors = grid_->neighbors();
  std::vector<std::int32_t>& shore = ids_;
  shore.clear();
  for (const std::int32_t node : queue_) {
    for (std::int32_t link = offsets[node]; link < offsets[node + 1]; ++link) {
      if (!grid_->dry(neighbors[link])) {
        shore.push_back(node);
        break;
      }
    }
  }
  std::sort(shore.begin(), shore.end());

  // The narrowest crossing from that shore onto the enemy shaman's landmass,
  // within the spell's reach: the strait, wherever it is, not just the line
  // straight at her.
  flood(enemy_node);
  const double reach = rules.range / grid_->planet_radius();
  const double cos_reach = std::cos(reach);
  std::int32_t near = -1;
  std::int32_t far = -1;
  double narrowest = -2.0;  // the best crossing's cosine: higher is narrower
  for (const std::int32_t from_node : shore) {
    const float* a = grid_->direction(from_node);
    for (const std::int32_t to_node : queue_) {
      const float* b = grid_->direction(to_node);
      const double cosine = (static_cast<double>(a[0]) * b[0] + static_cast<double>(a[1]) * b[1] +
                             static_cast<double>(a[2]) * b[2]);
      if (cosine >= cos_reach && cosine > narrowest) {
        narrowest = cosine;
        near = from_node;
        far = to_node;
      }
    }
  }
  if (near < 0) {
    return false;  // An ocean, not a strait.
  }
  double from[3];
  node_dir(*grid_, near, from);
  double at[3];
  node_dir(*grid_, far, at);

  SpellTarget target;
  for (int k = 0; k < 3; ++k) {
    target.at[k] = at[k];
    target.from[k] = from[k];
  }
  const SpellResult result = shamans_->check(Spell::kLandBridge, tribe, target);
  if (result == SpellResult::kOk) {
    return shamans_->cast(Spell::kLandBridge, tribe, target) == SpellResult::kOk;
  }
  if (result != SpellResult::kOutOfRange) {
    return false;
  }
  // Too far from the strait: she walks to the near end and casts on a later
  // think, once she is idle there.
  const std::int32_t shaman = followers_->shaman(tribe);
  ids_.assign(1, shaman);
  return followers_->order_move(ids_, from[0], from[1], from[2]) > 0;
}

bool TribeAi::try_patch_spell(std::int32_t tribe) {
  const std::int32_t shaman = followers_->shaman(tribe);
  const double* at = followers_->direction(shaman);
  const double radius = grid_->planet_radius();

  const std::int32_t patch = personality(tribe).patch;
  if (patch <= 0) {
    return false;
  }
  for (const Spell spell : {Spell::kSwamp, Spell::kBlast}) {
    const SpellRules& rules = spell_rules(spell);
    if (!shamans_->unlocked(tribe, spell) || shamans_->mana(tribe) < rules.cost ||
        shamans_->cooldown(tribe, spell) > 0.0) {
      continue;
    }
    const double reach = rules.range / radius;
    const double disc = shamans_->spell_angle(spell);
    const double hut_margin = kHutRadius / radius;

    // Centred on each enemy in range in turn; the one catching the most,
    // with nobody of her own on it and none of her huts under it.
    std::int32_t best = -1;
    std::int32_t best_count = 0;
    for (std::int32_t f = 0; f < followers_->count(); ++f) {
      const std::int32_t other = followers_->tribe(f);
      if (other == tribe || !valid_tribe(other)) {
        continue;
      }
      const double* centre = followers_->direction(f);
      if (angle_between(at, centre) > reach) {
        continue;
      }
      std::int32_t caught = 0;
      bool own = false;
      for (std::int32_t g = 0; g < followers_->count() && !own; ++g) {
        if (angle_between(centre, followers_->direction(g)) >= disc) {
          continue;
        }
        if (followers_->tribe(g) == tribe) {
          own = true;
        } else {
          ++caught;
        }
      }
      for (std::int32_t h = 0; h < huts_->count() && !own; ++h) {
        own = huts_->tribe(h) == tribe &&
              angle_between(centre, huts_->direction(h)) < disc + hut_margin;
      }
      if (!own && caught > best_count) {
        best = f;
        best_count = caught;
      }
    }
    if (best < 0 || best_count < patch) {
      continue;
    }
    SpellTarget target;
    const double* centre = followers_->direction(best);
    target.at[0] = centre[0];
    target.at[1] = centre[1];
    target.at[2] = centre[2];
    if (shamans_->cast(spell, tribe, target) == SpellResult::kOk) {
      return true;
    }
  }
  return false;
}

std::int32_t TribeAi::huts_of(std::int32_t tribe, HutKind kind) const {
  std::int32_t total = 0;
  for (std::int32_t h = 0; h < huts_->count(); ++h) {
    if (huts_->tribe(h) == tribe && huts_->kind(h) == static_cast<std::int32_t>(kind)) {
      ++total;
    }
  }
  return total;
}

AiAction TribeAi::try_build(std::int32_t tribe, Mind& mind) {
  const std::int32_t dwellings = huts_of(tribe, HutKind::kDwelling);
  const std::int32_t training = huts_of(tribe, HutKind::kTraining);
  if (dwellings + training >= personality(tribe).hut_cap) {
    mind.pad = -1;
    return AiAction::kWait;
  }
  // A training hut before more dwellings, so there are warriors to send; but
  // the free first dwelling is taken while it is free.
  const HutKind kind = training == 0 && huts_->cost(HutKind::kDwelling, tribe) > 0
                           ? HutKind::kTraining
                           : HutKind::kDwelling;
  if (stores_->wood(tribe) < huts_->cost(kind, tribe)) {
    return AiAction::kWait;
  }

  const double radius = grid_->planet_radius();
  auto place_on = [&](std::int32_t node) -> bool {
    double at[3];
    node_dir(*grid_, node, at);
    // Door towards home, so the village faces in on itself.
    const double d = dot3(at, mind.home);
    double door[3] = {mind.home[0] - at[0] * d, mind.home[1] - at[1] * d, mind.home[2] - at[2] * d};
    if (!normalize3(door)) {
      door[0] = door[1] = door[2] = 0.0;
    }
    return huts_->place(at[0], at[1], at[2], door[0], door[1], door[2], tribe, kind) >= 0;
  };

  // A pad being flattened: wait for it to land, then build, or give it up.
  if (mind.pad >= 0) {
    if (shamans_->casting(tribe) == static_cast<std::int32_t>(Spell::kFlatten)) {
      return AiAction::kWait;
    }
    const std::int32_t pad = mind.pad;
    mind.pad = -1;
    double at[3];
    node_dir(*grid_, pad, at);
    if (huts_->check_site(at[0], at[1], at[2], kind, tribe) == HutSite::kOk && place_on(pad)) {
      return AiAction::kBuild;
    }
    mind.spoiled.push_back(pad);
  }

  // Nodes near home, nearest first.
  const double reach = personality(tribe).build_reach / radius;
  ranked_.clear();
  for (std::int32_t node = 0; node < grid_->node_count(); ++node) {
    if (!grid_->walkable(node)) {
      continue;
    }
    double at[3];
    node_dir(*grid_, node, at);
    const double angle = angle_between(at, mind.home);
    if (angle <= reach) {
      ranked_.emplace_back(angle, node);
    }
  }
  std::sort(ranked_.begin(), ranked_.end());

  // A Flatten writes a disc: keep it off every hut standing, so it never
  // drags a pad already built on.
  const double flatten = shamans_->spell_angle(Spell::kFlatten) + kHutRadius / radius;
  std::int32_t to_flatten = -1;
  for (const auto& entry : ranked_) {
    const std::int32_t node = entry.second;
    if (std::find(mind.spoiled.begin(), mind.spoiled.end(), node) != mind.spoiled.end()) {
      continue;
    }
    double at[3];
    node_dir(*grid_, node, at);
    const HutSite site = huts_->check_site(at[0], at[1], at[2], kind, tribe);
    if (site == HutSite::kOk) {
      return place_on(node) ? AiAction::kBuild : AiAction::kWait;
    }
    if (site != HutSite::kUneven || to_flatten >= 0) {
      continue;
    }
    bool clear = true;
    for (std::int32_t h = 0; h < huts_->count() && clear; ++h) {
      clear = angle_between(at, huts_->direction(h)) > flatten;
    }
    if (!clear) {
      continue;
    }
    // One she could flatten from where she stands, once she can pay: the
    // nearest such is the pad, and she waits for the mana rather than
    // looking further out.
    SpellTarget target;
    node_dir(*grid_, node, target.at);
    const SpellResult can = shamans_->check(Spell::kFlatten, tribe, target);
    if (can == SpellResult::kOk || can == SpellResult::kNoMana || can == SpellResult::kCooling) {
      to_flatten = node;
    }
  }

  if (to_flatten < 0 || !shaman_idle(tribe)) {
    return AiAction::kWait;
  }
  SpellTarget target;
  node_dir(*grid_, to_flatten, target.at);
  if (shamans_->cast(Spell::kFlatten, tribe, target) != SpellResult::kOk) {
    return AiAction::kWait;
  }
  mind.pad = to_flatten;
  return AiAction::kFlatten;
}

void TribeAi::idle_braves(std::int32_t tribe, std::vector<std::int32_t>& out) const {
  out.clear();
  for (std::int32_t f = 0; f < followers_->count(); ++f) {
    if (followers_->tribe(f) == tribe && followers_->is_brave(f) && !followers_->is_shaman(f) &&
        !followers_->is_walking(f) && followers_->hut(f) < 0 && followers_->tree(f) < 0 &&
        followers_->takes_orders(f)) {
      out.push_back(f);
    }
  }
}

std::int32_t TribeAi::open_training_hut(std::int32_t tribe) const {
  for (std::int32_t h = 0; h < huts_->count(); ++h) {
    if (huts_->tribe(h) == tribe &&
        huts_->kind(h) == static_cast<std::int32_t>(HutKind::kTraining) &&
        huts_->occupants(h) + huts_->incoming(h) < HutSet::capacity(HutKind::kTraining)) {
      return h;
    }
  }
  return -1;
}

bool TribeAi::try_chop(std::int32_t tribe, const Mind& mind) {
  idle_braves(tribe, ids_);
  // One brave stays back for a training hut that could take him now, or
  // chopping would keep every hand busy and nobody would ever train.
  if (!ids_.empty() && open_training_hut(tribe) >= 0 && stores_->wood(tribe) >= kWarriorWoodCost) {
    ids_.pop_back();
  }
  if (ids_.empty()) {
    return false;
  }

  const double reach = personality(tribe).forage_reach / grid_->planet_radius();
  ranked_.clear();
  for (std::int32_t t = 0; t < trees_->count(); ++t) {
    const double angle = angle_between(trees_->direction(t), mind.home);
    if (angle <= reach) {
      ranked_.emplace_back(angle, t);
    }
  }
  std::sort(ranked_.begin(), ranked_.end());

  // Every idle hand at once, a tree's worth at a time, nearest trees first.
  std::int32_t sent = 0;
  for (const auto& entry : ranked_) {
    if (ids_.empty()) {
      break;
    }
    const std::int32_t tree = entry.second;
    if (trees_->order_chop(ids_, tree) <= 0) {
      continue;
    }
    std::vector<std::int32_t> rest;
    for (const std::int32_t f : ids_) {
      if (followers_->tree(f) == tree) {
        ++sent;
      } else {
        rest.push_back(f);
      }
    }
    ids_.swap(rest);
  }
  return sent > 0;
}

std::int32_t TribeAi::housed(std::int32_t tribe) const {
  std::int32_t total = 0;
  for (std::int32_t h = 0; h < huts_->count(); ++h) {
    if (huts_->tribe(h) == tribe &&
        huts_->kind(h) == static_cast<std::int32_t>(HutKind::kDwelling)) {
      total += huts_->occupants(h) + huts_->incoming(h);
    }
  }
  return total;
}

std::int32_t TribeAi::open_dwelling(std::int32_t tribe) const {
  std::int32_t best = -1;
  std::int32_t room = 0;
  for (std::int32_t h = 0; h < huts_->count(); ++h) {
    if (huts_->tribe(h) != tribe ||
        huts_->kind(h) != static_cast<std::int32_t>(HutKind::kDwelling)) {
      continue;
    }
    const std::int32_t left =
        HutSet::capacity(HutKind::kDwelling) - huts_->occupants(h) - huts_->incoming(h);
    if (left > room) {
      best = h;
      room = left;
    }
  }
  return best;
}

bool TribeAi::try_settle(std::int32_t tribe) {
  const std::int32_t wanted = personality(tribe).settle - housed(tribe);
  if (wanted <= 0) {
    return false;
  }
  const std::int32_t hut = open_dwelling(tribe);
  if (hut < 0) {
    return false;
  }
  idle_braves(tribe, ids_);
  // At least one stays out to chop, or the village would house its last
  // pair of hands and never build again.
  if (ids_.size() <= 1) {
    return false;
  }
  ids_.pop_back();
  if (static_cast<std::int32_t>(ids_.size()) > wanted) {
    ids_.resize(static_cast<std::size_t>(wanted));
  }
  return huts_->order_enter(ids_, hut) > 0;
}

bool TribeAi::try_train(std::int32_t tribe) {
  const std::int32_t hut = open_training_hut(tribe);
  if (hut < 0 || stores_->wood(tribe) < kWarriorWoodCost) {
    return false;
  }
  idle_braves(tribe, ids_);
  if (ids_.empty()) {
    return false;
  }
  // order_enter takes the nearest of those it is given, up to the room.
  return huts_->order_enter(ids_, hut) > 0;
}

bool TribeAi::try_attack(std::int32_t tribe, const Mind& mind) {
  // Idle warriors out in the field are sent on at once; those still at home
  // wait until there are enough of them to march together.
  const double home_ground = personality(tribe).forage_reach / grid_->planet_radius();
  ids_.clear();
  std::vector<std::int32_t>& at_home = queue_;
  at_home.clear();
  for (std::int32_t f = 0; f < followers_->count(); ++f) {
    if (followers_->tribe(f) == tribe && followers_->role(f) == Role::kWarrior &&
        !followers_->is_walking(f) && followers_->takes_orders(f)) {
      if (angle_between(followers_->direction(f), mind.home) <= home_ground) {
        at_home.push_back(f);
      } else {
        ids_.push_back(f);
      }
    }
  }
  if (static_cast<std::int32_t>(at_home.size()) >= personality(tribe).muster) {
    ids_.insert(ids_.end(), at_home.begin(), at_home.end());
  }
  if (ids_.empty()) {
    return false;
  }
  const std::int32_t enemy = enemy_shaman(tribe, followers_->direction(ids_.front()));
  if (enemy < 0) {
    return false;
  }
  const double* e = followers_->direction(enemy);
  return followers_->order_move(ids_, e[0], e[1], e[2]) > 0;
}

}  // namespace inkulous
