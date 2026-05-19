import type { CadView } from "@cadsense/contracts";

export type CadBaseView = "top" | "bottom" | "front" | "back" | "left" | "right" | "isometric";

export type CadViewVector = {
  readonly direction: readonly [number, number, number];
  readonly up: readonly [number, number, number];
};

export function cadBaseView(view: CadView): CadBaseView {
  if (view.endsWith("-close-up")) {
    return view.slice(0, -"-close-up".length) as CadBaseView;
  }
  return view as CadBaseView;
}

export function cadViewIsCloseUp(view: CadView): boolean {
  return view.endsWith("-close-up");
}

export function cadViewVector(view: CadView): CadViewVector {
  switch (cadBaseView(view)) {
    case "top":
      return { direction: [0, 0, 1], up: [0, 1, 0] };
    case "bottom":
      return { direction: [0, 0, -1], up: [0, 1, 0] };
    case "front":
      return { direction: [0, -1, 0], up: [0, 0, 1] };
    case "back":
      return { direction: [0, 1, 0], up: [0, 0, 1] };
    case "left":
      return { direction: [-1, 0, 0], up: [0, 0, 1] };
    case "right":
      return { direction: [1, 0, 0], up: [0, 0, 1] };
    case "isometric":
      return { direction: [1, -1, 1], up: [0, 0, 1] };
  }
}

export function cadViewLabel(view: CadView): string {
  const suffix = cadViewIsCloseUp(view) ? " Close" : "";
  switch (cadBaseView(view)) {
    case "top":
      return `Top${suffix}`;
    case "bottom":
      return `Bottom${suffix}`;
    case "front":
      return `Front${suffix}`;
    case "back":
      return `Back${suffix}`;
    case "left":
      return `Left${suffix}`;
    case "right":
      return `Right${suffix}`;
    case "isometric":
      return `Iso${suffix}`;
  }
}
