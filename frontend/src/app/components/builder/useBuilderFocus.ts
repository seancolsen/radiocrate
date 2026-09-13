import { useLayoutEffect, type RefObject } from "react";
import type { Section } from "../../../query/definition";
import { useApp, useAppActions } from "../../stores/react";

/** Consumes a pending `query.focus_*` request aimed at this builder — once,
 * and only when it names this tab (and, when given, this section) — by
 * focusing `ref`'s element and clearing the request. Shared by
 * `FilterBuilder` (fixed to `"filter"`), `SingleBuilder` (`"sort"` /
 * `"display"`) and `FullBuilder` (no `section` — a full-mode query has only
 * one editor, so any focus command lands there). `useLayoutEffect`, since the
 * request must be consumed only once the field it targets exists — this also
 * fires on mount, when the command that opened the section is what's pending. */
export function useBuilderFocus(
  tabId: string,
  section: Section | undefined,
  ref: RefObject<HTMLElement | null>,
): void {
  const req = useApp((s) => s.builderFocus);
  const { clearBuilderFocus } = useAppActions();
  useLayoutEffect(() => {
    if (!req || req.tabId !== tabId) return;
    if (section !== undefined && req.section !== section) return;
    ref.current?.focus();
    clearBuilderFocus();
  }, [req, tabId, section, ref, clearBuilderFocus]);
}
