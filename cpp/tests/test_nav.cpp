// The navigation graph: committing it, finding ground, routes, blocked nodes.

#include <vector>

#include <doctest/doctest.h>

#include "support.hpp"

using namespace testing_support;
using inkulous::NavGrid;
using inkulous::NavPoint;

namespace {

// Two hemispheres' worth of sea: everything with y < 0 is water.
double northern_land(const Vec3& d) { return d[1] >= 0.0 ? kLand : 0.0; }

}  // namespace

TEST_CASE("allocate refuses nonsense sizes") {
  NavGrid grid;
  CHECK_FALSE(grid.allocate(0, 0));
  CHECK_FALSE(grid.allocate(-1, 10));
  CHECK_FALSE(grid.allocate(10, -1));
  CHECK(grid.allocate(4, 0));
  CHECK_FALSE(grid.ready());
}

TEST_CASE("a graph is ready only once its topology checks out") {
  NavGrid grid;
  REQUIRE(grid.allocate(3, 2));
  // Offsets that do not add up to the link count: left zeroed, so node 2's
  // offset (0) is not link_count (2).
  grid.commit(1.0, 0.0);
  CHECK_FALSE(grid.ready());

  World world;
  CHECK(world.sim.nav().ready());
  CHECK(world.sim.nav().node_count() == world.graph.node_count);
  // 6 faces of 12x12 cells, welded: 6 * 144 + 2 nodes on a cube sphere.
  CHECK(world.graph.node_count == 6 * 12 * 12 + 2);
}

TEST_CASE("every node of a flat planet is walkable ground, and links are symmetric") {
  World world;
  const auto& nav = world.sim.nav();
  for (std::int32_t node = 0; node < nav.node_count(); ++node) {
    REQUIRE(nav.walkable(node));
  }
  // Every link has a link back: the graph is undirected.
  for (std::int32_t node = 0; node < nav.node_count(); ++node) {
    for (std::int32_t link = world.graph.offsets[static_cast<std::size_t>(node)];
         link < world.graph.offsets[static_cast<std::size_t>(node) + 1]; ++link) {
      const std::int32_t other = world.graph.neighbors[static_cast<std::size_t>(link)];
      bool back = false;
      for (std::int32_t l = world.graph.offsets[static_cast<std::size_t>(other)];
           l < world.graph.offsets[static_cast<std::size_t>(other) + 1]; ++l) {
        back = back || world.graph.neighbors[static_cast<std::size_t>(l)] == node;
      }
      REQUIRE(back);
    }
  }
}

TEST_CASE("nearest_walkable_node lands on dry ground, nearest_node on the nearest ground") {
  World world(12, northern_land);
  const auto& nav = world.sim.nav();
  const std::int32_t land = nav.nearest_walkable_node(0.0, 1.0, 0.0);
  REQUIRE(land >= 0);
  CHECK(nav.walkable(land));

  // Looking down into the southern sea there is a node, but it is not walkable
  // — and the walkable search reaches over to the shore instead.
  const std::int32_t sea = nav.nearest_node(0.0, -1.0, 0.0);
  REQUIRE(sea >= 0);
  CHECK_FALSE(nav.walkable(sea));
  const std::int32_t shore = nav.nearest_walkable_node(0.0, -1.0, 0.0);
  REQUIRE(shore >= 0);
  CHECK(nav.walkable(shore));
}

TEST_CASE("a planet with no land has nowhere to stand") {
  World world(8, [](const Vec3&) { return 0.0; });
  CHECK(world.sim.nav().nearest_walkable_node(0.0, 1.0, 0.0) == -1);
}

TEST_CASE("find_path walks node to node, and the string-pulled route is shorter") {
  World world;
  auto& nav = world.sim.nav();
  const std::int32_t from = nav.nearest_walkable_node(0.0, 0.0, 1.0);
  const std::int32_t to = nav.nearest_walkable_node(1.0, 0.5, 0.2);

  std::vector<std::int32_t> nodes;
  REQUIRE(nav.find_path(from, to, nodes));
  REQUIRE(nodes.size() >= 2);
  // The route starts at the first node *after* `from` and ends on `to`.
  CHECK(nodes.front() != from);
  CHECK(nodes.back() == to);
  // Each hop is a link of the graph.
  CHECK(nav.passable(from, nodes.front()));
  for (std::size_t i = 1; i < nodes.size(); ++i) {
    CHECK(nav.passable(nodes[i - 1], nodes[i]));
  }

  NavPoint start;
  NavPoint goal;
  for (int c = 0; c < 3; ++c) {
    start.dir[c] = static_cast<double>(nav.direction(from)[c]);
    goal.dir[c] = static_cast<double>(nav.direction(to)[c]);
  }
  start.node = from;
  goal.node = to;
  std::vector<NavPoint> legs;
  nav.smooth_path(start, nodes, goal, legs);
  REQUIRE_FALSE(legs.empty());
  CHECK(legs.size() < nodes.size());
}

TEST_CASE("a route to the node you are standing on is empty, and still a route") {
  World world;
  auto& nav = world.sim.nav();
  const std::int32_t node = nav.nearest_walkable_node(0.0, 1.0, 0.0);
  std::vector<std::int32_t> nodes;
  REQUIRE(nav.find_path(node, node, nodes));
  CHECK(nodes.empty());
}

TEST_CASE("no route crosses water") {
  // A ring of sea cuts the northern cap off from everything else.
  World world(16, [](const Vec3& d) {
    const double polar = std::acos(d[1]);
    return (polar > 0.5 && polar < 0.8) ? 0.0 : static_cast<double>(kLand);
  });
  auto& nav = world.sim.nav();
  const std::int32_t cap = nav.nearest_walkable_node(0.0, 1.0, 0.0);
  const std::int32_t far = nav.nearest_walkable_node(0.0, -1.0, 0.0);
  REQUIRE(cap >= 0);
  REQUIRE(far >= 0);
  std::vector<std::int32_t> nodes;
  CHECK_FALSE(nav.find_path(cap, far, nodes));
  // But there is still a route inside the cap.
  const std::int32_t near_cap = nav.nearest_walkable_node(0.3, 1.0, 0.0);
  CHECK(nav.find_path(cap, near_cap, nodes));
}

TEST_CASE("steep ground is a wall") {
  // A cliff along the equator: a step of 0.3 over a link a tenth of a radian
  // long is far past the walkable slope.
  World world(16, [](const Vec3& d) { return d[1] > 0.0 ? 0.3 : 0.001; });
  auto& nav = world.sim.nav();
  const std::int32_t north = nav.nearest_walkable_node(0.0, 1.0, 0.0);
  const std::int32_t south = nav.nearest_walkable_node(0.0, -1.0, 0.0);
  std::vector<std::int32_t> nodes;
  CHECK_FALSE(nav.find_path(north, south, nodes));
}

TEST_CASE("a blocked node is refused like water, and a route goes round it") {
  World world;
  auto& nav = world.sim.nav();
  const std::int32_t from = nav.nearest_walkable_node(0.0, 0.0, 1.0);
  const std::int32_t to = nav.nearest_walkable_node(0.0, 0.0, -1.0);
  std::vector<std::int32_t> before;
  REQUIRE(nav.find_path(from, to, before));
  REQUIRE(before.size() > 3);

  const std::int32_t middle = before[before.size() / 2];
  nav.set_blocked(middle, true);
  CHECK(nav.blocked(middle));
  CHECK_FALSE(nav.walkable(middle));
  CHECK(nav.dry(middle));

  std::vector<std::int32_t> after;
  REQUIRE(nav.find_path(from, to, after));
  for (const std::int32_t node : after) CHECK(node != middle);

  nav.set_blocked(middle, false);
  CHECK(nav.walkable(middle));
}

TEST_CASE("a fresh allocation clears what stood on the old graph") {
  World world;
  auto& nav = world.sim.nav();
  const std::uint32_t generation = nav.topology_generation();
  nav.set_blocked(0, true);
  REQUIRE(nav.allocate(world.graph.node_count,
                       static_cast<std::int32_t>(world.graph.neighbors.size())));
  CHECK(nav.topology_generation() != generation);
  CHECK_FALSE(nav.ready());
  CHECK_FALSE(nav.blocked(0));
}

TEST_CASE("the surface under a point is the ground a walker would stand on") {
  World world;
  auto& nav = world.sim.nav();
  const double dir[3] = {0.0, 1.0, 0.0};
  inkulous::SurfacePoint point;
  nav.sample(dir, nav.nearest_walkable_node(0.0, 1.0, 0.0), point);
  CHECK(point.height == doctest::Approx(static_cast<double>(kLand)));
  CHECK(nav.standable(point, inkulous::kRouteSupport));
}
