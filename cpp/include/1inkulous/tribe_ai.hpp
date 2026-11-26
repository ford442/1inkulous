#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "1inkulous/followers.hpp"
#include "1inkulous/huts.hpp"
#include "1inkulous/nav.hpp"
#include "1inkulous/shaman.hpp"
#include "1inkulous/state_hash.hpp"
#include "1inkulous/trees.hpp"
#include "1inkulous/tribes.hpp"

// A tribe the player does not control.
//
// Not every fixed step: every kAiThinkSeconds the mind of each tribe it runs
// looks at the world and does at most one thing, the first of these that
// applies:
//
//   1. the shaman is idle, and a spell is legal and useful: cast it
//        - Land Bridge, only when water cuts the tribe's warriors off from
//          the enemy shaman and a strait narrow enough to span is in reach;
//          she walks to the near shore first, and goes nowhere if the tribe
//          cannot pay for the bridge
//        - Swamp, else Blast, on a patch of enemies in her range with none
//          of her own people on it
//   2. the wood allows a hut and the village has fewer than kAiHutCap:
//      place one on level ground near home, or, with none level, have the
//      shaman Flatten a pad for it (the hut goes up on a later think)
//   3. fewer braves are housed than the tribe means to keep breeding, and
//      a dwelling has room: send idle braves in (a personality's `settle`)
//   4. braves are idle and a tree is near: send them to chop
//   5. a training hut has room and the wood allows: send a brave in
//   6. warriors are idle: send them at the enemy shaman — those at home
//      once there are `muster` of them, those already out at once
//
// How it weighs all that is a personality (AiPersonality): how often it
// thinks, how many huts it wants, how far it looks, how big a crowd a spell
// must catch, how many warriors it gathers before marching, how many braves
// it keeps at home breeding, and whether it bridges. The defaults are the AI
// as it always played; a scenario hands each tribe its own, which is how a
// world sets the difficulty.
//
// Every one of those goes through the calls the player's clicks reach —
// Shamans::cast, HutSet::place and order_enter, TreeSet::order_chop,
// FollowerSet::order_move — so nothing here touches the terrain or a follower
// directly. Once the match is over, or the tribe's own shaman has fallen,
// it does nothing more.

namespace inkulous {

// Seconds between one think and the next.
constexpr double kAiThinkSeconds = 2.0;
// Huts of either kind a tribe's AI stops building at.
constexpr std::int32_t kAiHutCap = 4;
// How far from home, in world units along the ground, it will put a hut.
constexpr double kAiBuildReach = 0.35;
// How far from home it sends braves for wood.
constexpr double kAiForageReach = 0.6;
// Fewest enemies one Swamp or Blast must catch to be worth the mana.
constexpr std::int32_t kAiPatch = 3;

// The weights a tribe's AI plays by. Data, not code: a scenario names a
// personality and TypeScript hands its numbers in through core_ai_configure.
// Every default is the constant above, so an unconfigured tribe plays as the
// AI always has.
struct AiPersonality {
  // Seconds between thinks: lower is quicker to react, and harder.
  double think_seconds = kAiThinkSeconds;
  // Huts of either kind it stops building at.
  std::int32_t hut_cap = kAiHutCap;
  // World units round home it builds within, and forages within.
  double build_reach = kAiBuildReach;
  double forage_reach = kAiForageReach;
  // Fewest enemies a Swamp or Blast must catch; 0 never casts either.
  std::int32_t patch = kAiPatch;
  // Idle warriors at home it gathers before sending them; those already out
  // are always sent on. 1 sends each as soon as he is trained.
  std::int32_t muster = 1;
  // Braves it keeps inside its dwellings to breed. 0 keeps none.
  std::int32_t settle = 0;
  // Whether it raises Land Bridges for its warriors.
  bool bridges = true;
};

// The personality as the AI uses it: each field clamped to a sensible range.
AiPersonality sanitized(const AiPersonality& personality);

// What a think did. Values cross the ABI as ints.
enum class AiAction : std::int32_t {
  // Nothing applied: she waits.
  kWait = 0,
  // The shaman started a spell. Which one is Shamans::casting.
  kCast = 1,
  // The shaman set off for the shore to bridge a strait from.
  kToShore = 2,
  // A hut went up.
  kBuild = 3,
  // The shaman started flattening a pad for the next hut.
  kFlatten = 4,
  // Braves were sent to chop.
  kChop = 5,
  // A brave was sent into a training hut.
  kTrain = 6,
  // Warriors were sent at the enemy shaman.
  kAttack = 7,
  // Braves were sent into a dwelling to breed.
  kSettle = 8,
};

class TribeAi {
 public:
  // None is owned; all must outlive the AI.
  void attach(NavGrid* grid,
              FollowerSet* followers,
              HutSet* huts,
              TreeSet* trees,
              Shamans* shamans,
              Stockpile* stores) {
    grid_ = grid;
    followers_ = followers;
    huts_ = huts;
    trees_ = trees;
    shamans_ = shamans;
    stores_ = stores;
  }

  // Hands `tribe` to the AI. Home — where it builds and forages round — is
  // the tribe's first hut, or where its shaman stands if it has none. False,
  // and nothing changed, for a bad tribe or one with neither.
  bool enable(std::int32_t tribe);
  void disable(std::int32_t tribe);
  bool enabled(std::int32_t tribe) const;

  // The weights `tribe` plays by, kept across enable() and disable() and put
  // back to the defaults by clear(). False for a bad tribe.
  bool configure(std::int32_t tribe, const AiPersonality& personality);
  const AiPersonality& personality(std::int32_t tribe) const;

  // What the tribe's last think did, and how many thinks have done
  // something. kWait and 0 before the first.
  AiAction last_action(std::int32_t tribe) const;
  std::int32_t actions(std::int32_t tribe) const;
  // Thinks so far, whether or not they did anything.
  std::int32_t thinks(std::int32_t tribe) const;

  // One fixed step: each enabled tribe whose wait is up thinks once.
  void step(double dt_seconds);

  void clear();

  // Mixes in everything of this that decides the next step. See state_hash.hpp.
  void hash(StateHash& out) const;

 private:
  struct Mind {
    bool on = false;
    double home[3] = {0.0, 1.0, 0.0};
    double wait = kAiThinkSeconds;
    AiAction last = AiAction::kWait;
    std::int32_t done = 0;
    std::int32_t thinks = 0;
    // The node a Flatten is being cast on for the next hut, or -1.
    std::int32_t pad = -1;
    // Nodes a Flatten was cast on that still would not take a hut.
    std::vector<std::int32_t> spoiled;
  };

  AiAction think(std::int32_t tribe, Mind& mind);

  bool shaman_idle(std::int32_t tribe) const;
  // The nearest standing shaman of another tribe, by angle from `from`, or -1.
  std::int32_t enemy_shaman(std::int32_t tribe, const double from[3]) const;

  bool try_bridge(std::int32_t tribe);
  bool try_patch_spell(std::int32_t tribe);
  AiAction try_build(std::int32_t tribe, Mind& mind);
  bool try_chop(std::int32_t tribe, const Mind& mind);
  // People of `tribe` inside its dwellings, and the dwelling with the most
  // room left (-1 if none has any).
  std::int32_t housed(std::int32_t tribe) const;
  std::int32_t open_dwelling(std::int32_t tribe) const;
  bool try_settle(std::int32_t tribe);
  bool try_train(std::int32_t tribe);
  bool try_attack(std::int32_t tribe, const Mind& mind);

  // Braves of `tribe` with nothing to do: not walking, not bound for a hut
  // or a tree, not the shaman.
  void idle_braves(std::int32_t tribe, std::vector<std::int32_t>& out) const;
  // A training hut of `tribe` with room for one more, or -1.
  std::int32_t open_training_hut(std::int32_t tribe) const;
  std::int32_t huts_of(std::int32_t tribe, HutKind kind) const;
  // Marks every node reachable on foot from `start` in reach_stamp_.
  void flood(std::int32_t start);
  bool reached(std::int32_t node) const {
    return node >= 0 && reach_stamp_[static_cast<std::size_t>(node)] == reach_generation_;
  }

  NavGrid* grid_ = nullptr;
  FollowerSet* followers_ = nullptr;
  HutSet* huts_ = nullptr;
  TreeSet* trees_ = nullptr;
  Shamans* shamans_ = nullptr;
  Stockpile* stores_ = nullptr;
  std::array<Mind, kMaxTribes> minds_{};
  std::array<AiPersonality, kMaxTribes> personalities_{};

  // Scratch kept allocated between thinks.
  std::vector<std::uint32_t> reach_stamp_;
  std::uint32_t reach_generation_ = 0;
  std::vector<std::int32_t> queue_;
  std::vector<std::int32_t> ids_;
  std::vector<std::pair<double, std::int32_t>> ranked_;
};

}  // namespace inkulous
