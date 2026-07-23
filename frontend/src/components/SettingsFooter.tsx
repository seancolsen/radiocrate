import { Icons } from "../icons";

/** The static Settings footer pinned to the sidebar bottom: gear icon + muted
 * "Settings" label, with a hover background. Rendered only — no menu/behavior
 * this phase. */
export default function SettingsFooter() {
  return (
    <div class="text-ink-weak hover:bg-hover hover:text-ink flex h-[30px] shrink-0 items-center gap-2 pl-3">
      <Icons.Settings class="size-4" />
      <span class="text-[13px]">Settings</span>
    </div>
  );
}
