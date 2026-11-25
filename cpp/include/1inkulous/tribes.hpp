#pragma once

#include <array>
#include <cstdint>

#include "1inkulous/state_hash.hpp"

// What a tribe holds in common, apart from its people: for now, wood.
//
// Mana lives with the shamans (shaman.hpp), because only a shaman spends it.
// Wood is spent by buildings — a hut, a training hut, a warrior's kit — and
// earned by braves felling trees, so it sits here where huts and trees can
// both reach it without either owning the other.

namespace inkulous {

// Tribes the core keeps stores for: the four placeholder colours.
constexpr std::int32_t kMaxTribes = 4;

inline bool valid_tribe(std::int32_t tribe) { return tribe >= 0 && tribe < kMaxTribes; }

class Stockpile {
 public:
  // 0 for a tribe out of range.
  std::int32_t wood(std::int32_t tribe) const {
    return valid_tribe(tribe) ? wood_[static_cast<std::size_t>(tribe)] : 0;
  }
  // Clamped at 0. For tests and scenario setup.
  void set_wood(std::int32_t tribe, std::int32_t wood) {
    if (valid_tribe(tribe)) {
      wood_[static_cast<std::size_t>(tribe)] = wood > 0 ? wood : 0;
    }
  }
  void add_wood(std::int32_t tribe, std::int32_t wood) {
    if (valid_tribe(tribe) && wood > 0) {
      wood_[static_cast<std::size_t>(tribe)] += wood;
    }
  }
  // Takes `wood` from the tribe if it has that much; false, and nothing
  // taken, if it has not. Spending nothing always succeeds.
  bool spend_wood(std::int32_t tribe, std::int32_t wood) {
    if (wood <= 0) {
      return true;
    }
    if (!valid_tribe(tribe) || wood_[static_cast<std::size_t>(tribe)] < wood) {
      return false;
    }
    wood_[static_cast<std::size_t>(tribe)] -= wood;
    return true;
  }

  void clear() { wood_.fill(0); }

  void hash(StateHash& out) const {
    for (const std::int32_t wood : wood_) {
      out.add(wood);
    }
  }

 private:
  std::array<std::int32_t, kMaxTribes> wood_{};
};

}  // namespace inkulous
