#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "1inkulous/followers.hpp"
#include "1inkulous/huts.hpp"
#include "1inkulous/nav.hpp"
#include "1inkulous/state_hash.hpp"
#include "1inkulous/terrain.hpp"
#include "1inkulous/tribes.hpp"

// Shamans: one special follower per tribe, the mana her people pray up, and
// the spells she casts with it.
//
// The shaman herself is an ordinary follower with kFlagShaman set, so she
// walks, paths and is selected through FollowerSet like everyone else. What
// lives here is what only she has: her tribe's mana, and every spell.
//
// Every spell goes through one path, whoever is casting — the player's keys
// or, later, an enemy shaman's AI:
//
//   check(spell, tribe, target)  would it go ahead, and if not, why
//   cast(spell, tribe, target)   the same check; on kOk she starts casting
//
// A cast takes the spell's cast time. She stops where she stands and carries
// kFlagCasting while it lasts. Any move order she is given, a second cast, or
// being moved out of the spell's range ends it early with nothing spent.
// When the time is up the check runs again on the world as it is then; if it
// still passes, the mana is spent, the spell's cooldown starts and the spell
// writes the terrain itself, through Terrain, so the mesh picks it up from the
// dirty range and the very next order walks the new ground. A refused cast,
// at the start or at the end, spends nothing and writes no height.
//
// The spells so far all change the ground:
//
//   Land Bridge  raises a strip along the great circle between two points,
//                one of them by default where she stands
//   Blast        raises a disc, the way the brush does, and throws everyone
//                standing on it out past its rim
//   Flatten      pulls a disc to the height at its centre: a hut pad
//   Swamp        drops a disc to sea level, so it is water; anyone caught on
//                it is set down on the nearest dry node and stops

namespace inkulous {

// Mana each living member of a tribe — out walking or inside a hut — adds per
// second. A village of a dozen pays for a bridge in a quarter of a minute.
constexpr double kManaPerPersonSecond = 1.0;
// Mana stops piling up here.
constexpr double kMaxMana = 1000.0;

// Values cross the ABI as ints.
enum class Spell : std::int32_t {
  kLandBridge = 0,
  kBlast = 1,
  kFlatten = 2,
  kSwamp = 3,
};
constexpr std::int32_t kSpellCount = 4;

inline bool valid_spell(std::int32_t spell) { return spell >= 0 && spell < kSpellCount; }

// What every spell has, whatever it does. Lengths are world units along the
// surface.
struct SpellRules {
  // Mana, spent when the cast completes.
  double cost;
  // Furthest the target may be from the shaman — for a bridge, both ends —
  // when the cast starts and for as long as it lasts.
  double range;
  // Radius of the disc it writes; for a bridge, of each stamp along it.
  double radius;
  // How long she stands casting before it lands.
  double cast_seconds;
  // How long after it lands before the tribe may cast it again.
  double cooldown_seconds;
};

constexpr SpellRules kSpellRules[kSpellCount] = {
    // Land Bridge. Range: a strait, not an ocean. The strip comes out about
    // three grid cells wide, room for followers to pass two abreast.
    {200.0, 0.3, 0.09, 1.0, 3.0},
    // Blast: a hill about a cell and a half across.
    {200.0, 0.3, 0.1, 1.0, 4.0},
    // Flatten: wide enough that the hut footprint round whichever node a
    // click snaps to lands inside the part of the disc pulled fully level.
    {150.0, 0.3, 0.16, 1.0, 3.0},
    // Swamp: a bog a few cells across, wide enough that a route has to go
    // round rather than cut across a corner of it.
    {250.0, 0.3, 0.12, 1.5, 5.0},
};

inline const SpellRules& spell_rules(Spell spell) {
  const auto index = static_cast<std::int32_t>(spell);
  return kSpellRules[valid_spell(index) ? index : 0];
}

// Land Bridge: an end counts as ashore when walkable land is within this of
// it, so a click in the shallows a cell off the beach still joins the beach.
constexpr double kLandBridgeShoreReach = 0.1;
// Height the stamps raise the centre line to, above sea level.
constexpr double kLandBridgeHeight = 0.01;
// Most stamps a plan holds. A bridge at full range needs about fifteen.
constexpr std::int32_t kMaxLandBridgeStamps = 64;
// Blast: how much the centre of the disc rises, as the brush would raise it.
constexpr double kBlastHeight = 0.02;
// Flatten and Swamp pull the disc this far at its centre in one go — far
// more than any height on the planet, so everything but the very rim lands
// on the target exactly.
constexpr double kSpellFlattenRate = 1.0;

// Why a spell will or will not go ahead, or how a cast ended. Values cross
// the ABI as ints.
enum class SpellResult : std::int32_t {
  kOk = 0,
  kNoGrid = 1,
  // The tribe has no shaman to cast it.
  kNoShaman = 2,
  // The target is further from the shaman than the spell's range.
  kOutOfRange = 3,
  // Land Bridge: neither end is near land, a bridge from nowhere to nowhere.
  kNoShore = 4,
  // Land Bridge: the line is dry already; there is nothing to raise.
  kDry = 5,
  // Not enough mana.
  kNoMana = 6,
  // The tribe cast this spell too recently.
  kCooling = 7,
  // The ground is already what the spell would make it — Flatten on level
  // ground, Swamp on water, Blast at the height ceiling with nobody to throw.
  kNothing = 8,
  // Flatten: the centre is under water, and a pad at sea level is a swamp.
  kWet = 9,
  // Only as how a cast ended: another order, or another cast, cut it short.
  kCancelled = 10,
  // No such spell.
  kUnknownSpell = 11,
  // The tribe has not unlocked this spell yet (see Shamans::set_unlock).
  kLocked = 12,
};

// An unlock threshold for a spell the tribe never gets this match.
constexpr std::int32_t kSpellNever = -1;

// Where a spell is aimed. Directions need not be normalised.
struct SpellTarget {
  // The disc's centre; a bridge's far end.
  double at[3] = {0.0, 0.0, 0.0};
  // A bridge's near end. All zero — the default — is wherever the shaman
  // stands when the cast starts. Ignored by the disc spells.
  double from[3] = {0.0, 0.0, 0.0};
};

// How a tribe's most recent cast ended. `count` goes up by one each time one
// does, so a reader can tell a new ending from the one it saw last.
struct CastEnd {
  std::uint32_t count = 0;
  Spell spell = Spell::kLandBridge;
  // kOk: it landed. Otherwise why it did not.
  SpellResult result = SpellResult::kOk;
};

class Shamans {
 public:
  // None is owned; all must outlive the set.
  void attach(NavGrid* grid, Terrain* terrain, FollowerSet* followers, HutSet* huts) {
    grid_ = grid;
    terrain_ = terrain;
    followers_ = followers;
    huts_ = huts;
  }

  // Spawns `tribe`'s shaman on the walkable node nearest the direction.
  // Returns her follower id, or -1 if the tribe already has one, the tribe is
  // out of range, or the follower set refuses the spawn.
  std::int32_t spawn(double x, double y, double z, std::int32_t tribe);

  // 0 for a tribe out of range.
  double mana(std::int32_t tribe) const;
  // Clamped to [0, kMaxMana]. For tests and scenario setup.
  void set_mana(std::int32_t tribe, double mana);
  // Mana per second the tribe is gaining right now.
  double income(std::int32_t tribe) const;
  // Everyone of the tribe, walking or housed, as of the last step.
  std::int32_t population(std::int32_t tribe) const;

  // Whether `tribe`'s shaman could cast `spell` at `target` now, and if not,
  // why. Changes nothing.
  SpellResult check(Spell spell, std::int32_t tribe, const SpellTarget& target) const;
  // The same check; on kOk she stops and starts casting, ending any cast she
  // was already in the middle of (kCancelled). On a refusal nothing changes,
  // and a cast already under way carries on.
  SpellResult cast(Spell spell, std::int32_t tribe, const SpellTarget& target);
  // Ends `tribe`'s cast in progress, if there is one, as kCancelled.
  void cancel(std::int32_t tribe);

  // The spell `tribe`'s shaman is casting right now, or -1.
  std::int32_t casting(std::int32_t tribe) const;
  // How far through it she is, 0..1; 0 when she is not casting.
  double cast_progress(std::int32_t tribe) const;
  // Where it will land, for drawing: the disc's centre (a bridge's far end)
  // and its angular radius. False when she is not casting.
  bool cast_disc(std::int32_t tribe, double out[3], double& angular_radius) const;
  // Seconds before `tribe` may cast `spell` again; 0 when it may.
  double cooldown(std::int32_t tribe, Spell spell) const;

  // Spell progression. Every spell starts unlocked for every tribe; a
  // scenario can hold one back: `at` 0 unlocks it now, kSpellNever locks it
  // for the match, and a positive `at` locks it until the tribe's population
  // first reaches that many (counted each step, as mana is), after which it
  // stays unlocked. A locked spell is refused by check() as kLocked, which is
  // how the AI is held to the same rules. Ignores a bad tribe or spell.
  void set_unlock(std::int32_t tribe, Spell spell, std::int32_t at);
  // The threshold as it stands: 0 unlocked, kSpellNever, or the population
  // still to reach. kSpellNever for a bad tribe or spell.
  std::int32_t unlock_at(std::int32_t tribe, Spell spell) const;
  bool unlocked(std::int32_t tribe, Spell spell) const { return unlock_at(tribe, spell) == 0; }
  // How `tribe`'s most recent cast ended. All zeros before the first.
  CastEnd last_end(std::int32_t tribe) const;

  // The match: over once a shaman has been killed and at most one tribe's
  // shaman still stands. The winner is that tribe, or -1 while the match goes
  // on — or when the last two fell on the same step. Reincarnation is not in
  // yet, so a shaman's death is final.
  bool match_over() const;
  std::int32_t winner() const;

  // Angular radius, in radians, of the disc `spell` writes on this planet.
  double spell_angle(Spell spell) const;

  // The stamps the last Land Bridge to land laid: 3 floats (a unit
  // direction) each, every one spell_angle(kLandBridge) across.
  const float* stamps() const { return stamps_.data(); }
  std::int32_t stamp_count() const { return static_cast<std::int32_t>(stamps_.size() / 3); }

  // One fixed step: counts each tribe and adds its mana, then moves every
  // cast on — ending it early if she was ordered away or moved out of range,
  // landing it once its time is up.
  void step(double dt_seconds);

  void clear();

  // Mixes in everything of this that decides the next step. See state_hash.hpp.
  void hash(StateHash& out) const;

 private:
  struct Cast {
    bool active = false;
    Spell spell = Spell::kLandBridge;
    // With the bridge's near end filled in where she stood.
    SpellTarget target;
    double elapsed = 0.0;
    // Her orders() when the cast began: a change is a new order.
    std::uint32_t orders = 0;
  };

  // The shaman `tribe` casts with, or -1, judged as check() judges her.
  std::int32_t caster(std::int32_t tribe) const;
  // The ends of a Land Bridge from `a` to `b` as it would be raised —
  // wet ends pulled onto a beach near them — or why it would not be. Range
  // is judge()'s business.
  SpellResult bridge_ends(const double a_in[3],
                          const double b_in[3],
                          double a[3],
                          double b[3]) const;
  // Everything check() asks except the cooldown and the mana: whether the
  // spell has something to do at `target`, in range of `shaman_at`.
  SpellResult judge(Spell spell, const double* shaman_at, const SpellTarget& target) const;
  // `target` with its directions normalised and a bridge's near end filled
  // in from `shaman_at`. False if a direction is degenerate.
  bool resolve(Spell spell, const double* shaman_at, const SpellTarget& in, SpellTarget& out) const;
  // Writes the spell. Only after judge() said kOk.
  void apply(Spell spell, const SpellTarget& target);
  // Ends `tribe`'s cast as `result` and clears her flag.
  void end(std::int32_t tribe, SpellResult result);

  // True when some point of the ground under `dir` that carries real weight
  // is water — the line needs raising there.
  bool wet(const double dir[3]) const;
  // Direction of the walkable node nearest `dir` when it lies within
  // kLandBridgeShoreReach; false otherwise.
  bool shore_near(const double dir[3], double out[3]) const;
  // Whether anyone stands within `angle` of `centre`.
  bool anyone_within(const double centre[3], double angle) const;
  void count_population();

  // Lays a bridge's stamps on the terrain, in order, from `a` to `b`.
  void raise_land(const double a[3], const double b[3]);

  NavGrid* grid_ = nullptr;
  Terrain* terrain_ = nullptr;
  FollowerSet* followers_ = nullptr;
  HutSet* huts_ = nullptr;
  std::array<double, kMaxTribes> mana_{};
  std::array<std::int32_t, kMaxTribes> population_{};
  std::array<Cast, kMaxTribes> casts_{};
  std::array<CastEnd, kMaxTribes> ends_{};
  std::array<std::array<double, kSpellCount>, kMaxTribes> cooldowns_{};
  // Per tribe and spell: 0 unlocked, kSpellNever, or a population to reach.
  std::array<std::array<std::int32_t, kSpellCount>, kMaxTribes> unlock_{};
  std::vector<float> stamps_;
};

}  // namespace inkulous
