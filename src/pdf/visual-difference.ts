import type { PdfVisualDifference } from "./export-diagnostics";
import type { PdfDocumentHandle } from "./types";

type Observation = Awaited<ReturnType<NonNullable<PdfDocumentHandle["inspectPage"]>>>;
type Sample = NonNullable<Observation["visualSample"]>;

function valid(sample: Sample | undefined): sample is Sample {
  return !!sample && Number.isInteger(sample.width) && sample.width > 0 && sample.width <= 128 &&
    Number.isInteger(sample.height) && sample.height > 0 && sample.height <= 128 &&
    sample.pixels instanceof Uint8Array && sample.pixels.length === sample.width * sample.height * 4;
}

/** Never return the internal digests or graphics parameters to callers of diagnostics. */
export function renderSignatureDifference(before: Observation, after: Observation): PdfVisualDifference {
  const signatures: PdfVisualDifference = {};
  for (const [key, diagnostic] of [["viewport", "viewportEqual"], ["graphics", "graphicsEqual"]] as const) {
    const first = before.renderSignature?.[key], second = after.renderSignature?.[key];
    if (typeof first === "string" && /^[a-f0-9]{64}$/.test(first) &&
      typeof second === "string" && /^[a-f0-9]{64}$/.test(second)) signatures[diagnostic] = first === second;
  }
  return signatures;
}

/** Diagnostics only: never a tolerance or alternate acceptance path. */
export function visualDifference(before: Observation, after: Observation): PdfVisualDifference | undefined {
  const signatures = renderSignatureDifference(before, after);
  const left = before.visualSample;
  const right = after.visualSample;
  if (!valid(left) || !valid(right)) return Object.keys(signatures).length ? signatures : undefined;
  const dimensions = { ...signatures, sourceRasterWidth: left.width, sourceRasterHeight: left.height,
    outputRasterWidth: right.width, outputRasterHeight: right.height };
  if (left.width !== right.width || left.height !== right.height) return dimensions;
  let changedPixels = 0;
  let maxChannelDelta = 0;
  let absoluteDelta = 0;
  for (let pixel = 0; pixel < left.pixels.length; pixel += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(left.pixels[pixel + channel] - right.pixels[pixel + channel]);
      changed ||= delta !== 0;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      absoluteDelta += delta;
    }
    if (changed) changedPixels++;
  }
  return { ...dimensions, totalPixels: left.width * left.height, changedPixels, maxChannelDelta,
    meanAbsoluteDelta: Math.round(absoluteDelta / left.pixels.length * 1_000_000) / 1_000_000 };
}

export function eraseVisualSample(observation: Observation | undefined): void {
  observation?.visualSample?.pixels.fill(0);
}
