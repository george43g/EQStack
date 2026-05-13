// Barrel for per-category op modules. Importing this file triggers each
// module's top-level `registry.register(...)` side-effect, so the singleton
// is populated before the dispatcher runs.
//
// Add an import line per category as the refactor progresses; ordering
// doesn't matter (the registry rejects duplicates).

import "./health.js";

export {};
