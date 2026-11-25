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

bool Shamans::match_over() const {
  if (followers_ == nullptr) {
    return false;
  }
  bool anyone_fell = false;
  std::int32_t standing = 0;
  for (std::int32_t tribe = 0; tribe < kMaxTribes; ++tribe) {
    anyone_fell = anyone_fell || followers_->fallen(tribe);
    standing += followers_->shaman(tribe) >= 0 ? 1 : 0;
  }
  return anyone_fell && standing <= 1;
}

std::int32_t Shamans::winner() const {
  if (!match_over()) {
    return -1;
  }
  for (std::int32_t tribe = 0; tribe < kMaxTribes; ++tribe) {
    if (followers_->shaman(tribe) >= 0) {
      return tribe;
    }
  }
  return -1;
}

double Shamans::spell_angle(Spell spell) const {
  const double radius = grid_ != nullptr ? grid_->planet_radius() : 1.0;
  return spell_rules(spell).radius / radius;
}

std::int32_t Shamans::caster(std::int32_t tribe) const {
  if (followers_ == nullptr || !valid_tribe(tribe)) {
    return -1;
  }
  return followers_->shaman(tribe);
}

bool Shamans::resolve(Spell spell,
                      const double* shaman_at,
                      const SpellTarget& in,
                      SpellTarget& out) const {
  out = in;
  if (!normalize3(out.at)) {
    return false;
  }
  if (spell != Spell::kLandBridge) {
    return true;
  }
  if (out.from[0] == 0.0 && out.from[1] == 0.0 && out.from[2] == 0.0) {
    out.from[0] = shaman_at[0];
    out.from[1] = shaman_at[1];
    out.from[2] = shaman_at[2];
  }
  return normalize3(out.from);
}

SpellResult Shamans::bridge_ends(const double a_in[3],
                                 const double b_in[3],
                                 double a[3],
                                 double b[3]) const {
  for (int i = 0; i < 3; ++i) {
    a[i] = a_in[i];
    b[i] = b_in[i];
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
    return SpellResult::kNoShore;
  }

  // Walk the line a fraction of a cell at a time looking for water. A line
  // the graph already crosses on dry ground would cost mana and raise nothing.
  const double theta = angle_between(a, b);
  const double sample_step = std::max(grid_->min_link_angle() * 0.5, 1e-4);
  const std::int32_t samples =
      std::max(1, static_cast<std::int32_t>(std::ceil(theta / sample_step)));
  for (std::int32_t i = 0; i <= samples; ++i) {
    double p[3];
    slerp(a, b, theta, static_cast<double>(i) / samples, p);
    if (wet(p)) {
      return SpellResult::kOk;
    }
  }
  return SpellResult::kDry;
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
        !grid_->dry(ground.nodes[corner])) {
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

bool Shamans::anyone_within(const double centre[3], double angle) const {
  for (std::int32_t f = 0; f < followers_->count(); ++f) {
    if (angle_between(centre, followers_->direction(f)) < angle) {
      return true;
    }
  }
  return false;
}

SpellResult Shamans::judge(Spell spell, const double* shaman_at, const SpellTarget& target) const {
  // She has to be able to reach the target from where she stands; for a
  // bridge, both ends of it.
  const double reach = spell_rules(spell).range / grid_->planet_radius();
  if (angle_between(shaman_at, target.at) > reach ||
      (spell == Spell::kLandBridge && angle_between(shaman_at, target.from) > reach)) {
    return SpellResult::kOutOfRange;
  }
  if (spell == Spell::kLandBridge) {
    double a[3];
    double b[3];
    return bridge_ends(target.from, target.at, a, b);
  }

  const double angle = spell_angle(spell);
  switch (spell) {
    case Spell::kBlast:
      // Something to raise, or someone to throw.
      return terrain_->would_sculpt(target.at, angle, kBlastHeight) ||
                     anyone_within(target.at, angle)
                 ? SpellResult::kOk
                 : SpellResult::kNothing;
    case Spell::kFlatten: {
      const double level = terrain_->height_at(target.at);
      if (!(level > kWaterHeight)) {
        return SpellResult::kWet;
      }
      return terrain_->would_flatten(target.at, angle, level, kSpellFlattenRate)
                 ? SpellResult::kOk
                 : SpellResult::kNothing;
    }
    case Spell::kSwamp:
      return terrain_->would_flatten(target.at, angle, 0.0, kSpellFlattenRate)
                 ? SpellResult::kOk
                 : SpellResult::kNothing;
    default:
      return SpellResult::kUnknownSpell;
  }
}

SpellResult Shamans::check(Spell spell, std::int32_t tribe, const SpellTarget& target) const {
  if (grid_ == nullptr || terrain_ == nullptr || followers_ == nullptr || !grid_->ready()) {
    return SpellResult::kNoGrid;
  }
  const auto index = static_cast<std::int32_t>(spell);
  if (!valid_spell(index)) {
    return SpellResult::kUnknownSpell;
  }
  const std::int32_t shaman = caster(tribe);
  if (shaman < 0) {
    return SpellResult::kNoShaman;
  }
  const double* at = followers_->direction(shaman);
  SpellTarget resolved;
  if (!resolve(spell, at, target, resolved)) {
    return SpellResult::kNoGrid;
  }
  const SpellResult ground = judge(spell, at, resolved);
  if (ground != SpellResult::kOk) {
    return ground;
  }
  const auto t = static_cast<std::size_t>(tribe);
  if (mana_[t] < spell_rules(spell).cost) {
    return SpellResult::kNoMana;
  }
  if (cooldowns_[t][static_cast<std::size_t>(index)] > 0.0) {
    return SpellResult::kCooling;
  }
  return SpellResult::kOk;
}

SpellResult Shamans::cast(Spell spell, std::int32_t tribe, const SpellTarget& target) {
  const SpellResult result = check(spell, tribe, target);
  if (result != SpellResult::kOk) {
    return result;
  }
  // A second cast is a second order: the first one ends unspent.
  cancel(tribe);

  const std::int32_t shaman = caster(tribe);
  Cast& cast = casts_[static_cast<std::size_t>(tribe)];
  cast.active = true;
  cast.spell = spell;
  resolve(spell, followers_->direction(shaman), target, cast.target);
  cast.elapsed = 0.0;
  // She stands to cast. Halting is not an order, so the count is the one
  // the next order will change.
  followers_->halt(shaman);
  cast.orders = followers_->orders(shaman);
  followers_->set_casting(shaman, true);
  return SpellResult::kOk;
}

void Shamans::cancel(std::int32_t tribe) {
  if (valid_tribe(tribe) && casts_[static_cast<std::size_t>(tribe)].active) {
    end(tribe, SpellResult::kCancelled);
  }
}

void Shamans::end(std::int32_t tribe, SpellResult result) {
  const auto t = static_cast<std::size_t>(tribe);
  Cast& cast = casts_[t];
  cast.active = false;
  const std::int32_t shaman = caster(tribe);
  if (shaman >= 0) {
    followers_->set_casting(shaman, false);
  }
  CastEnd& ending = ends_[t];
  ending.count += 1;
  ending.spell = cast.spell;
  ending.result = result;
}

std::int32_t Shamans::casting(std::int32_t tribe) const {
  if (!valid_tribe(tribe) || !casts_[static_cast<std::size_t>(tribe)].active) {
    return -1;
  }
  return static_cast<std::int32_t>(casts_[static_cast<std::size_t>(tribe)].spell);
}

double Shamans::cast_progress(std::int32_t tribe) const {
  if (casting(tribe) < 0) {
    return 0.0;
  }
  const Cast& cast = casts_[static_cast<std::size_t>(tribe)];
  return std::clamp(cast.elapsed / spell_rules(cast.spell).cast_seconds, 0.0, 1.0);
}

bool Shamans::cast_disc(std::int32_t tribe, double out[3], double& angular_radius) const {
  if (casting(tribe) < 0) {
    return false;
  }
  const Cast& cast = casts_[static_cast<std::size_t>(tribe)];
  out[0] = cast.target.at[0];
  out[1] = cast.target.at[1];
  out[2] = cast.target.at[2];
  angular_radius = spell_angle(cast.spell);
  return true;
}

double Shamans::cooldown(std::int32_t tribe, Spell spell) const {
  const auto index = static_cast<std::int32_t>(spell);
  if (!valid_tribe(tribe) || !valid_spell(index)) {
    return 0.0;
  }
  return cooldowns_[static_cast<std::size_t>(tribe)][static_cast<std::size_t>(index)];
}

CastEnd Shamans::last_end(std::int32_t tribe) const {
  return valid_tribe(tribe) ? ends_[static_cast<std::size_t>(tribe)] : CastEnd{};
}

void Shamans::apply(Spell spell, const SpellTarget& target) {
  const double angle = spell_angle(spell);
  switch (spell) {
    case Spell::kLandBridge: {
      // Judged already; this is for the ends pulled onto the beaches.
      double a[3];
      double b[3];
      bridge_ends(target.from, target.at, a, b);
      raise_land(a, b);
      break;
    }
    case Spell::kBlast:
      terrain_->sculpt(target.at, angle, kBlastHeight);
      // A spacing past the rim, so nobody lands on its very edge.
      followers_->shove(target.at, angle, kFollowerSpacing / grid_->planet_radius());
      followers_->reroute_across(target.at, angle);
      break;
    case Spell::kFlatten:
      terrain_->flatten(target.at, angle, terrain_->height_at(target.at), kSpellFlattenRate);
      followers_->reroute_across(target.at, angle);
      break;
    case Spell::kSwamp:
      terrain_->flatten(target.at, angle, 0.0, kSpellFlattenRate);
      followers_->strand(target.at, angle);
      followers_->reroute_across(target.at, angle);
      break;
  }
}

void Shamans::raise_land(const double a[3], const double b[3]) {
  stamps_.clear();
  // Stamps half a radius apart, so their falloffs overlap into one ridge
  // instead of a row of hummocks.
  const double radius = spell_angle(Spell::kLandBridge);
  const double theta = angle_between(a, b);
  const double spacing = radius * 0.5;
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
  // One stamp at a time, each reading the ground the last one left: a stamp
  // lifts its centre to the crest and no further, so overlapping stamps build
  // one ridge, and a stamp on ground already that high — the beaches at the
  // ends — lifts nothing. Its neighbours' falloff may still nudge it a little.
  for (std::int32_t i = 0; i < stamp_count(); ++i) {
    const double at[3] = {stamps_[idx(i * 3)], stamps_[idx(i * 3 + 1)], stamps_[idx(i * 3 + 2)]};
    const double lift = kLandBridgeHeight - terrain_->height_at(at);
    if (lift > 0.0) {
      terrain_->sculpt(at, radius, lift);
    }
  }
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
    mana_[tribe] =
        std::min(kMaxMana, mana_[tribe] + population_[tribe] * kManaPerPersonSecond * dt_seconds);
    // Steps are not exact in binary, so a wait within a hair of over is over.
    for (double& wait : cooldowns_[tribe]) {
      wait = wait > dt_seconds + 1e-9 ? wait - dt_seconds : 0.0;
    }
  }

  for (std::int32_t tribe = 0; tribe < kMaxTribes; ++tribe) {
    Cast& cast = casts_[static_cast<std::size_t>(tribe)];
    if (!cast.active) {
      continue;
    }
    const std::int32_t shaman = caster(tribe);
    if (shaman < 0) {
      end(tribe, SpellResult::kNoShaman);
      continue;
    }
    if (followers_->orders(shaman) != cast.orders) {
      end(tribe, SpellResult::kCancelled);
      continue;
    }
    // Pushed, shoved or sculpted out of reach: the spell fizzles.
    const double* at = followers_->direction(shaman);
    const double reach = spell_rules(cast.spell).range / grid_->planet_radius();
    if (angle_between(at, cast.target.at) > reach ||
        (cast.spell == Spell::kLandBridge && angle_between(at, cast.target.from) > reach)) {
      end(tribe, SpellResult::kOutOfRange);
      continue;
    }
    cast.elapsed += dt_seconds;
    if (cast.elapsed + 1e-9 < spell_rules(cast.spell).cast_seconds) {
      continue;
    }

    // Judged again on the world as it is now: the ground, the mana. Range
    // is checked from where she stands; a bridge keeps the near end it was
    // given when the cast began.
    const auto t = static_cast<std::size_t>(tribe);
    SpellResult result = judge(cast.spell, at, cast.target);
    if (result == SpellResult::kOk && mana_[t] < spell_rules(cast.spell).cost) {
      result = SpellResult::kNoMana;
    }
    if (result == SpellResult::kOk) {
      mana_[t] -= spell_rules(cast.spell).cost;
      cooldowns_[t][static_cast<std::size_t>(cast.spell)] =
          spell_rules(cast.spell).cooldown_seconds;
      apply(cast.spell, cast.target);
    }
    end(tribe, result);
  }
}

void Shamans::clear() {
  mana_.fill(0.0);
  population_.fill(0);
  casts_.fill(Cast{});
  ends_.fill(CastEnd{});
  for (auto& waits : cooldowns_) {
    waits.fill(0.0);
  }
  stamps_.clear();
}

}  // namespace inkulous
