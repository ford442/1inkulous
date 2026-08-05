// Thin shims between the flat C ABI and the C++ core. Keeping the boundary in
// one file makes it obvious what TypeScript is allowed to touch.

#include "1inkulous/core_abi.h"

#include "1inkulous/core.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define INKULOUS_EXPORT EMSCRIPTEN_KEEPALIVE
#else
// Native builds (unit tests, tooling) need no export annotation.
#define INKULOUS_EXPORT
#endif

namespace {

// One world per module, created on core_init and reused for the session.
inkulous::Simulation& simulation() {
  static inkulous::Simulation instance{inkulous::kDefaultStepMs};
  return instance;
}

}  // namespace

extern "C" {

INKULOUS_EXPORT int core_version(void) { return inkulous::core_version(); }

INKULOUS_EXPORT const char* core_version_text(void) {
  return inkulous::core_version_string();
}

INKULOUS_EXPORT void core_init(double step_ms) {
  simulation() = inkulous::Simulation{step_ms};
}

INKULOUS_EXPORT int core_tick(double delta_ms) {
  return static_cast<int>(simulation().advance(delta_ms));
}

INKULOUS_EXPORT double core_step_ms(void) { return simulation().step_ms(); }

INKULOUS_EXPORT double core_step_count(void) {
  return static_cast<double>(simulation().step_count());
}

INKULOUS_EXPORT double core_elapsed_ms(void) { return simulation().elapsed_ms(); }

INKULOUS_EXPORT double core_pending_ms(void) { return simulation().pending_ms(); }

INKULOUS_EXPORT void core_reset(void) { simulation().reset(); }

}  // extern "C"
