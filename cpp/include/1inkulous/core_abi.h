#pragma once

// Flat C ABI exposed to TypeScript across the WebAssembly boundary.
//
// Everything here is scalar in and scalar out. There is no marshalling of
// structs or strings into WASM, and nothing is copied per frame — as the
// simulation grows, bulk state should be read straight out of the module's
// linear memory (or written into it as a command buffer) rather than passed
// through these calls.
//
// The module owns a single simulation instance, matching the single world a
// match is played on. `core_init` (re)creates it.

#ifdef __cplusplus
extern "C" {
#endif

// Encoded as MAJOR * 10000 + MINOR * 100 + PATCH.
int core_version(void);

// Pointer to a static NUL-terminated version string, e.g. "0.1.0". Read it on
// the JS side with UTF8ToString.
const char* core_version_text(void);

// Creates the simulation with a fixed step length. Pass 0 for the default.
// Calling it again resets the clock.
void core_init(double step_ms);

// Feeds a frame's elapsed time in and runs whole fixed steps. Returns the
// number of steps executed this call, which may be 0 on a fast frame.
int core_tick(double delta_ms);

// Fixed step length in milliseconds.
double core_step_ms(void);

// Total steps run since init. A double, because an int64 does not cross the
// boundary cleanly and 2^53 steps is longer than any match.
double core_step_count(void);

// Simulated time in milliseconds: whole steps only.
double core_elapsed_ms(void);

// Time accumulated towards the next step, in milliseconds.
double core_pending_ms(void);

// Clears the clock, keeping the step length.
void core_reset(void);

#ifdef __cplusplus
}  // extern "C"
#endif
