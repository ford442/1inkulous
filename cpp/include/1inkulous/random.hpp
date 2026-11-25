#pragma once

#include <cstdint>

// The match's one source of chance.
//
// Everything in the core that wants a random choice draws from the single
// MatchRandom the Simulation owns, seeded when the match starts. Nothing else
// in the simulation may be random — no std::rand, no clock, no address — and
// nothing on the TypeScript side of the simulation may call Math.random
// (test:replay scans for it). That is what lets the same seed and the same
// commands replay the same match, and two lockstep peers stay in step.
//
// xorshift32: small, fast, and the same sequence on every platform. Integer
// only, so it cannot be the thing that differs between builds. Its state is
// part of the state hash.

namespace inkulous {

// The seed a core starts with before anyone seeds the match: the one the
// opening forest has always been planted from.
constexpr std::uint32_t kDefaultMatchSeed = 1;

class MatchRandom {
 public:
  explicit MatchRandom(std::uint32_t seed = kDefaultMatchSeed) { reseed(seed); }

  // Starts the sequence again from `seed`. Zero is xorshift's one fixed
  // point, so it is mapped to a constant rather than used.
  void reseed(std::uint32_t seed) {
    seed_ = seed;
    state_ = seed != 0 ? seed : 0x9e3779b9u;
  }

  std::uint32_t next() {
    state_ ^= state_ << 13;
    state_ ^= state_ >> 17;
    state_ ^= state_ << 5;
    return state_;
  }

  // [0, 1), 24 bits of it: exactly representable, so the same on every build.
  double unit() { return static_cast<double>(next() >> 8) / 16777216.0; }

  // [0, bound). Plain modulo: the bias is far below anything a game can see.
  std::uint32_t below(std::uint32_t bound) { return bound > 0 ? next() % bound : 0; }

  // What the match was last seeded with.
  std::uint32_t seed() const { return seed_; }
  std::uint32_t state() const { return state_; }

 private:
  std::uint32_t seed_ = kDefaultMatchSeed;
  std::uint32_t state_ = kDefaultMatchSeed;
};

}  // namespace inkulous
