#pragma once

#include <cstdint>

#include "1inkulous/nav.hpp"
#include "1inkulous/state_hash.hpp"
#include "1inkulous/worldgen.hpp"

// The terrain: the one height per nav node, and the only things allowed to
// change it.
//
// Nav nodes are the planet mesh's welded vertices, so the grid's height buffer
// *is* the walkable surface. TypeScript seeds it once from the generated field
// when the graph is committed; from then on every edit — the player's brush, a
// spell, anything an AI decides to do — goes through here, and the mesh is a
// view that copies the dirty nodes back onto its vertices each frame.
//
// Edits are judged in doubles and stored as float32, the same as the buffer
// the mesh draws from, so a node that has arrived compares equal to its target
// and stops being reported dirty.

namespace inkulous {

// An inclusive run of node ids. Empty when `last < first`.
struct NodeRange {
  std::int32_t first = 0;
  std::int32_t last = -1;

  bool empty() const { return last < first; }
  void include(std::int32_t node) {
    if (empty()) {
      first = node;
      last = node;
      return;
    }
    if (node < first) first = node;
    if (node > last) last = node;
  }
  void include(const NodeRange& other) {
    if (!other.empty()) {
      include(other.first);
      include(other.last);
    }
  }
};

// Steps smaller than this fraction of the height range are skipped: at the
// very rim of the brush the falloff goes to nothing, and a step that cannot
// survive being rounded into float32 would only dirty the buffer.
constexpr double kMinStepFraction = 1e-9;

class Terrain {
 public:
  // Not owned; must outlive the terrain.
  void attach(NavGrid* grid) { grid_ = grid; }

  // Highest the ground may be raised, in world units above sea level. Zero,
  // negative or non-finite leaves it unbounded.
  void set_max_height(double max_height);
  double max_height() const { return max_height_; }

  // Raises (positive delta) or lowers (negative) every node within
  // `angular_radius` of `centre`, by `delta` at the centre and smoothly less
  // towards the rim. Snaps to exactly sea level and to the cap rather than
  // approaching them: water is `height <= 0`, so a stroke meant to flood a
  // valley has to land on zero. Returns the nodes it moved.
  NodeRange sculpt(const double centre[3], double angular_radius, double delta);

  // Pulls every node within `angular_radius` towards `target`, by at most
  // `rate` at the centre and less towards the rim. A node within reach lands on
  // the target exactly, so a few strokes leave a truly level pad. Returns the
  // nodes it moved.
  NodeRange flatten(const double centre[3], double angular_radius, double target, double rate);

  // Whether sculpt() or flatten() with these arguments would move any node.
  // Nothing is written and nothing is marked dirty: this is how a spell's
  // check tells "nothing to do" without touching the ground.
  bool would_sculpt(const double centre[3], double angular_radius, double delta) const;
  bool would_flatten(const double centre[3],
                     double angular_radius,
                     double target,
                     double rate) const;

  // Replaces the whole field with a generated world (see worldgen.hpp), under
  // the ceiling, and marks every node dirty. What a scenario's procedural
  // terrain is: a seed and parameters, run once as the world is built. Returns
  // how many nodes are land, or -1 with no grid.
  std::int32_t generate(const WorldGenParams& params);

  // Marks every node dirty, for when the heights were written wholesale (a
  // scenario's own height field, or the editor putting its ground back).
  void touch_all();

  // Height above sea level under a direction, read off the same triangle of
  // the nearest node's fan that walkers stand on. Need not be normalised. Zero
  // with no grid.
  double height_at(const double dir[3]) const;

  // Every node an edit has moved since the last clear_dirty(): what the mesh
  // still has to copy.
  const NodeRange& dirty() const { return dirty_; }
  void clear_dirty() { dirty_ = NodeRange{}; }

  // Mixes in everything of this that decides the next step. See state_hash.hpp.
  void hash(StateHash& out) const;

 private:
  // Shared body of sculpt and flatten: visits each node inside the brush with
  // its falloff weight (1 at the centre, 0 at the rim) and its height, and
  // returns the nodes whose height `next` would change. With `commit` it
  // stores them; without, it only reports.
  template <typename Step>
  NodeRange brush(const double centre[3], double angular_radius, bool commit, Step next) const;
  // The per-node rule of each edit, shared by the edit and its dry run. The
  // caller widens the dirty range.
  NodeRange sculpt_impl(const double centre[3],
                        double angular_radius,
                        double delta,
                        bool commit) const;
  NodeRange flatten_impl(
      const double centre[3], double angular_radius, double target, double rate, bool commit) const;

  NavGrid* grid_ = nullptr;
  double max_height_ = 0.0;
  NodeRange dirty_;
};

}  // namespace inkulous
