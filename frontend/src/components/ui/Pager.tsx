import type { JSX } from "react";
import { Icons } from "../../icons";
import IconButton from "./IconButton";

/** The "‹ 1–50 of 120 ›" pager under a long list. Draws nothing for a single
 * page. `page` is zero-based. */
export default function Pager(props: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}): JSX.Element | null {
  const { page, pageSize, total, onPage } = props;
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  const first = page * pageSize;
  const last = Math.min(first + pageSize, total);
  return (
    <div className="text-ink-weak flex shrink-0 items-center justify-end gap-1 pt-0.5 text-xs">
      <IconButton
        icon={Icons.PagePrevious}
        label="Previous page"
        size="sm"
        tabIndex={-1}
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      />
      <span className="tabular-nums">
        {first + 1}–{last} of {total}
      </span>
      <IconButton
        icon={Icons.PageNext}
        label="Next page"
        size="sm"
        tabIndex={-1}
        disabled={page === pages - 1}
        onClick={() => onPage(page + 1)}
      />
    </div>
  );
}
