/**
 * Feature module contract.
 *
 * A feature module is a self-contained folder under `src/tui/modules/<id>/`
 * that registers one or more commands with the palette and renders into the
 * existing sidebar/thread-pane motif when an instance is opened.
 *
 * Lifecycle:
 *   1. User opens the palette and selects a command.
 *   2. The command's `open(ctx)` returns a `ModuleInstance` (or null for
 *      fire-and-forget actions).
 *   3. The reducer prepends the instance to `state.moduleInstances` and
 *      switches the sidebar cursor to it.
 *   4. The instance's `Pane` component renders in place of `ThreadPane`,
 *      managing its own keyboard input via Ink's `useInput`.
 *   5. The instance closes via `onClose` (typically bound to Esc) which
 *      removes it from state.
 */
import type React from "react";
import type { useImsg } from "../hooks/useImsg.js";
import type { CommandContext } from "../keymap.js";

export interface ModuleInstance {
  /** Unique per instance — module id + timestamp / counter. */
  id: string;
  /** Which `FeatureModule` produced this instance. */
  moduleId: string;
  /** Sidebar row title. */
  title: string;
  /** Optional dim second line. */
  subtitle?: string;
  /** Optional override of the default accent — hex color or a Palette key. */
  accentColor?: string;
  /** Module-owned state. The reducer treats this as opaque; the module casts back to its own type. */
  state: unknown;
}

export interface ModuleSidebarItemProps {
  instance: ModuleInstance;
  selected: boolean;
  focused: boolean;
  width: number;
  /** Index label shown in the relative line-num column (mirrors ConversationItem). */
  lineNum?: string;
  isLast?: boolean;
}

export interface ModulePaneProps {
  instance: ModuleInstance;
  imsg: ReturnType<typeof useImsg>;
  width: number;
  height: number;
  focused: boolean;
  /** Persist new module-owned state via the reducer. */
  onUpdateState: (next: unknown) => void;
  /** Remove the instance from the sidebar and fall focus back to the first real conversation. */
  onClose: () => void;
  /** Push a transient message into the StatusBar. */
  setStatus: (s: string) => void;
}

export interface ModuleCommand {
  /** Stable id, must be namespaced as `<moduleId>.<verb>`. */
  id: string;
  title: string;
  description?: string;
  /** Display string in the palette's keybinding column. Modules typically have no key. */
  keybinding?: string;
  /**
   * Return the instance to add to the sidebar, or `null` for a one-shot
   * (status toast / refresh / etc.).
   */
  open: (ctx: CommandContext) => ModuleInstance | null;
}

export interface FeatureModule {
  /** Stable id ("analytics", "export"). Must match the folder name. */
  id: string;
  /** Human label — prefixed onto the palette entry, e.g. "Analytics: Streaks". */
  name: string;
  /** Default accent color for sidebar rows if the instance doesn't override. */
  accentColor?: string;
  /** Commands registered with the palette. */
  commands: ModuleCommand[];
  /** Optional custom sidebar row renderer. Falls back to DefaultSidebarItem. */
  SidebarItem?: React.ComponentType<ModuleSidebarItemProps>;
  /** The right-pane renderer. Required. */
  Pane: React.ComponentType<ModulePaneProps>;
}
