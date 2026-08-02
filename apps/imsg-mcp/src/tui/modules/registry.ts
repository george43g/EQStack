/**
 * Static registry of feature modules. To add a new module, drop its folder
 * under `src/tui/modules/<id>/`, export a `FeatureModule`, and append it
 * here. The palette + sidebar pick it up automatically.
 */
import type { Command } from "../keymap.js";
import { CORE_COMMANDS } from "../keymap.js";
import type { AppState } from "../types.js";
import { analyticsModule } from "./analytics/module.js";
import type { FeatureModule, ModuleCommand } from "./types.js";

export const MODULES: FeatureModule[] = [analyticsModule];

/** Look up a module by id. Returns undefined for unknown ids. */
export function findModule(moduleId: string): FeatureModule | undefined {
  return MODULES.find((m) => m.id === moduleId);
}

/** Lift a `ModuleCommand` into the unified `Command` shape used by the palette. */
function liftModuleCommand(mod: FeatureModule, cmd: ModuleCommand): Command {
  return {
    id: cmd.id,
    title: cmd.title,
    description: cmd.description,
    category: mod.name,
    keybinding: cmd.keybinding,
    run: (ctx) => {
      const inst = cmd.open(ctx);
      if (inst) ctx.dispatch({ type: "OPEN_MODULE_INSTANCE", instance: inst });
    },
  };
}

/** Concatenate core commands with every registered module's commands. */
export function allCommands(state: AppState): Command[] {
  const out: Command[] = [];
  for (const c of CORE_COMMANDS) {
    if (c.when && !c.when(state)) continue;
    out.push(c);
  }
  for (const mod of MODULES) {
    for (const cmd of mod.commands) {
      out.push(liftModuleCommand(mod, cmd));
    }
  }
  return out;
}
