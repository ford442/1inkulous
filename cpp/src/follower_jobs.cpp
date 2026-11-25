// A follower's job: the hut it has been ordered into and the tree it has been
// sent to chop. The huts and trees themselves are in huts.cpp and trees.cpp;
// this is only the follower's side of the assignment.

#include "1inkulous/followers.hpp"

namespace inkulous {

std::int32_t FollowerSet::tree(std::int32_t id) const {
  if (id < 0 || id >= count()) {
    return -1;
  }
  return followers_[static_cast<std::size_t>(id)].tree;
}

void FollowerSet::set_tree(std::int32_t id, std::int32_t tree) {
  if (id < 0 || id >= count()) {
    return;
  }
  followers_[static_cast<std::size_t>(id)].tree = tree;
}

void FollowerSet::tree_removed(std::int32_t tree) {
  for (Follower& follower : followers_) {
    if (follower.tree == tree) {
      follower.tree = -1;
    } else if (follower.tree > tree) {
      follower.tree -= 1;
    }
  }
}

void FollowerSet::clear_trees() {
  for (Follower& follower : followers_) {
    follower.tree = -1;
  }
}

std::int32_t FollowerSet::hut(std::int32_t id) const {
  if (id < 0 || id >= count()) {
    return -1;
  }
  return followers_[static_cast<std::size_t>(id)].hut;
}

void FollowerSet::set_hut(std::int32_t id, std::int32_t hut) {
  if (id < 0 || id >= count()) {
    return;
  }
  followers_[static_cast<std::size_t>(id)].hut = hut;
}

void FollowerSet::clear_huts() {
  for (Follower& follower : followers_) {
    follower.hut = -1;
  }
}

}  // namespace inkulous
