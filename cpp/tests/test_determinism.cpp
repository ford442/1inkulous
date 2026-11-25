// The simulation is deterministic: the same commands over the same steps give
// the same world, bit for bit. The worker's replay (src/sim/worker.ts) proves a
// copy of the world by digest, and that is only sound while this holds.

#include <cstdint>
#include <cstring>
#include <vector>

#include <doctest/doctest.h>

#include "support.hpp"

using namespace testing_support;

namespace {

const Vec3 kHome = {0.0, 0.0, 1.0};

// FNV-1a over the bytes of every buffer the renderer reads.
std::uint64_t digest(World& world) {
  world.sim.followers().refresh_instances();
  world.sim.huts().refresh_instances();
  world.sim.trees().refresh_instances();
  std::uint64_t hash = 14695981039346656037ull;
  auto mix = [&hash](const void* data, std::size_t bytes) {
    const auto* p = static_cast<const unsigned char*>(data);
    for (std::size_t i = 0; i < bytes; ++i) hash = (hash ^ p[i]) * 1099511628211ull;
  };
  mix(world.sim.followers().instances(), static_cast<std::size_t>(world.sim.followers().count()) *
                                             inkulous::kFollowerInstanceFloats * sizeof(float));
  mix(world.sim.huts().instances(), static_cast<std::size_t>(world.sim.huts().count()) *
                                        inkulous::kHutInstanceFloats * sizeof(float));
  mix(world.sim.trees().instances(), static_cast<std::size_t>(world.sim.trees().count()) *
                                         inkulous::kTreeInstanceFloats * sizeof(float));
  for (std::int32_t node = 0; node < world.sim.nav().node_count(); ++node) {
    const float h = world.sim.nav().height(node);
    mix(&h, sizeof h);
  }
  return hash;
}

// A busy match: two tribes, an AI, a forest, a crowd sent across the planet.
std::uint64_t play() {
  World world;
  auto& sim = world.sim;
  sim.shamans().spawn(kHome[0], kHome[1], kHome[2], 0);
  const Vec3 far_side = step_towards(kHome, {1.0, 0.0, 0.0}, 1.4);
  sim.shamans().spawn(far_side[0], far_side[1], far_side[2], 1);
  sim.trees().spawn(30, 11);
  for (int i = 0; i < 20; ++i) {
    sim.followers().spawn(kHome[0], kHome[1], kHome[2], 0);
    sim.followers().spawn(far_side[0], far_side[1], far_side[2], 1);
  }
  sim.ai().enable(1);
  for (std::int32_t id = 0; id < sim.followers().count(); ++id) {
    if (sim.followers().tribe(id) == 0) sim.followers().set_selected(id, true);
  }
  const Vec3 goal = step_towards(kHome, {0.0, 1.0, 0.0}, 0.8);
  sim.followers().order_move_selected(goal[0], goal[1], goal[2]);
  world.run(30.0);
  return digest(world);
}

}  // namespace

TEST_CASE("two runs of the same match end in the same world") {
  const std::uint64_t first = play();
  const std::uint64_t second = play();
  CHECK(first == second);
}

TEST_CASE("the frame rate does not change the world") {
  auto run_at = [](double frame_ms) {
    World world;
    auto& sim = world.sim;
    for (int i = 0; i < 10; ++i) sim.followers().spawn(kHome[0], kHome[1], kHome[2], 0);
    for (std::int32_t id = 0; id < sim.followers().count(); ++id)
      sim.followers().set_selected(id, true);
    const Vec3 goal = step_towards(kHome, {1.0, 0.0, 0.0}, 0.6);
    sim.followers().order_move_selected(goal[0], goal[1], goal[2]);
    for (double elapsed = 0.0; elapsed < 10'000.0; elapsed += frame_ms) sim.advance(frame_ms);
    return digest(world);
  };
  CHECK(run_at(50.0) == run_at(25.0));
  CHECK(run_at(50.0) == run_at(100.0));
}
