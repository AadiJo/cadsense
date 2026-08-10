import { act, useMemo, useState } from "react";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../../index.css";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

const preview = {
  images: [
    { src: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", name: "one.png" },
    { src: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", name: "two.png" },
  ],
  index: 0,
};

let setDynamicImagesForTest: ((images: typeof preview.images) => void) | null = null;

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open preview
      </button>
      <button type="button">Outside control</button>
      {open && <ExpandedImageDialog preview={preview} onClose={() => setOpen(false)} />}
    </>
  );
}

function SingleImageHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open single preview
      </button>
      {open && (
        <ExpandedImageDialog
          preview={{ images: [preview.images[0]!], index: 0 }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function DynamicImagesHarness() {
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState(preview.images);
  setDynamicImagesForTest = setImages;
  const dynamicPreview = useMemo(() => ({ images, index: 1 }), [images]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dynamic preview
      </button>
      {open && <ExpandedImageDialog preview={dynamicPreview} onClose={() => setOpen(false)} />}
    </>
  );
}

test("manages focus, navigation, and dismissal", async () => {
  const screen = await render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open preview" });
  await opener.click();

  const dialog = screen.getByRole("dialog", { name: "Expanded image preview" });
  const closeButton = screen.getByRole("button", { name: "Close image preview" });
  await expect.element(dialog).toBeVisible();
  await expect.element(closeButton).toHaveFocus();

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(screen.getByRole("img", { name: "two.png" })).toBeVisible();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(screen.getByRole("img", { name: "one.png" })).toBeVisible();

  for (let index = 0; index < 6; index += 1) {
    await userEvent.keyboard("{Tab}");
    expect(dialog.element().contains(document.activeElement)).toBe(true);
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
});

test("restores focus after clicking the full-screen close target", async () => {
  const screen = await render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open preview" });
  await opener.click();

  await expect
    .element(screen.getByRole("button", { name: "Close image preview" }))
    .toBeInTheDocument();
  await screen.getByTestId("expanded-image-backdrop-close").click({ position: { x: 5, y: 5 } });
  await expect
    .element(screen.getByRole("dialog", { name: "Expanded image preview" }))
    .not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
});

test("dismisses the backdrop only on a primary click", async () => {
  const screen = await render(<Harness />);
  await screen.getByRole("button", { name: "Open preview" }).click();

  const dialog = screen.getByRole("dialog", { name: "Expanded image preview" });
  const backdropClose = screen.getByTestId("expanded-image-backdrop-close");
  await backdropClose.click({ button: "right", position: { x: 5, y: 5 } });
  await expect.element(dialog).toBeVisible();

  await backdropClose.click({ position: { x: 5, y: 5 } });
  await expect.element(dialog).not.toBeInTheDocument();
});

test("keeps the pointer-only close target out of the focus cycle", async () => {
  const screen = await render(<SingleImageHarness />);
  await screen.getByRole("button", { name: "Open single preview" }).click();

  const closeButton = screen.getByRole("button", { name: "Close image preview" });
  await expect.element(closeButton).toHaveFocus();

  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.element(closeButton).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect.element(closeButton).toHaveFocus();
});

test("normalizes a stale image index and closes when the image list becomes empty", async () => {
  const screen = await render(<DynamicImagesHarness />);
  const opener = screen.getByRole("button", { name: "Open dynamic preview" });
  await opener.click();
  await expect.element(screen.getByRole("img", { name: "two.png" })).toBeVisible();

  await act(() => setDynamicImagesForTest?.([preview.images[0]!]));
  await expect.element(screen.getByRole("img", { name: "one.png" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Close image preview" })).toHaveFocus();

  await act(() => setDynamicImagesForTest?.([]));
  await expect
    .element(screen.getByRole("dialog", { name: "Expanded image preview" }))
    .not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
});
