#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

// A hash of the simulation's state: the desync detector for lockstep and the
// regression oracle for replays.
//
// FNV-1a over the bytes of every field that decides what happens next —
// positions, routes, timers, stores, the AI's minds, the ground, the match's
// random state. Doubles go in as their bit patterns, so two cores agree only
// if they computed exactly the same numbers. Render buffers, scratch and the
// accumulator are left out: they decide nothing.
//
// Each system hashes its own private state (`hash(StateHash&) const`), all
// implemented side by side in src/state_hash.cpp so one file shows what is
// covered.

namespace inkulous {

class StateHash {
 public:
  void bytes(const void* data, std::size_t size) {
    const auto* p = static_cast<const std::uint8_t*>(data);
    for (std::size_t i = 0; i < size; ++i) {
      value_ ^= p[i];
      value_ *= 0x01000193u;
    }
  }

  void add(std::uint32_t v) { bytes(&v, sizeof v); }
  void add(std::int32_t v) { add(static_cast<std::uint32_t>(v)); }
  void add(bool v) { add(static_cast<std::uint32_t>(v ? 1 : 0)); }
  void add(std::int64_t v) {
    add(static_cast<std::uint32_t>(static_cast<std::uint64_t>(v)));
    add(static_cast<std::uint32_t>(static_cast<std::uint64_t>(v) >> 32));
  }
  void add(double v) { bytes(&v, sizeof v); }
  void add(float v) { bytes(&v, sizeof v); }
  void add3(const double v[3]) {
    add(v[0]);
    add(v[1]);
    add(v[2]);
  }

  // Length first, so [a][b] and [a, b] differ.
  template <typename T>
  void add_all(const std::vector<T>& values) {
    add(static_cast<std::uint32_t>(values.size()));
    for (const T& v : values) {
      add(v);
    }
  }
  void add_all(const std::vector<std::uint8_t>& values) {
    add(static_cast<std::uint32_t>(values.size()));
    bytes(values.data(), values.size());
  }

  std::uint32_t value() const { return value_; }

 private:
  std::uint32_t value_ = 0x811c9dc5u;
};

}  // namespace inkulous
