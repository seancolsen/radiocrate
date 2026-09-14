import type { JSX, ReactNode } from "react";

/** The record editor's loading indicator: a translucent wash, in the form's own
 * background color, over exactly the region whose data is in flight — so the
 * structure underneath (field labels, skeleton rows, empty embedded records)
 * reads as dimmed rather than missing. It also covers that region for pointer
 * events, which is the point: the user can't click into a value that's still
 * arriving. */
export default function LoadingRegion(props: {
  loading: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`relative ${props.className ?? ""}`}>
      {props.children}
      {props.loading && (
        <div className="bg-panel/65 absolute inset-0 z-10" aria-hidden="true" />
      )}
    </div>
  );
}
