/**
 * Volcengine Ark (Seedream) image client.
 * Ark serves image models via /images/generations instead of chat/completions,
 * so both map and character generators route through here when IMAGE_GEN_PROVIDER=ark.
 */

import sharp from "sharp";

// Seedream rejects outputs below ~1280x720 total pixels.
const MIN_PIXELS = parseInt(process.env.ARK_IMAGE_MIN_PIXELS || "921600", 10);
const MAX_PIXELS = 4096 * 4096;
const RATE_LIMIT_RETRIES = 4;

export function isArkProvider(provider, baseUrl) {
  return provider === "ark" || provider === "volcengine" || (!provider && baseUrl.includes("volces.com"));
}

function parseAspect(aspectRatio) {
  const [w, h] = String(aspectRatio || "1:1").split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

function sizeLabelToLongEdge(imageSize) {
  const k = parseInt(String(imageSize || "2K"), 10);
  return (Number.isFinite(k) && k > 0 ? k : 2) * 1024;
}

/** Pick a WxH (multiples of 16) for the given aspect, clamped to Seedream's pixel range. */
export function resolveArkSize(aspect, imageSize) {
  const longEdge = sizeLabelToLongEdge(imageSize);
  let w = aspect >= 1 ? longEdge : longEdge * aspect;
  let h = aspect >= 1 ? longEdge / aspect : longEdge;
  const pixels = w * h;
  const scale = pixels < MIN_PIXELS ? Math.sqrt(MIN_PIXELS / pixels) : pixels > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / pixels) : 1;
  w = Math.ceil((w * scale) / 16) * 16;
  h = Math.ceil((h * scale) / 16) * 16;
  return `${w}x${h}`;
}

async function postArk({ baseUrl, apiKey, model, body, signal }) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: "b64_json",
        watermark: false,
        ...body,
      }),
      signal,
    });

    // Seedream has a low per-minute request cap; back off instead of failing the step.
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      const waitMs = 15000 * (attempt + 1);
      console.warn(`[ark-seedream] Rate limited, waiting ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      throw new Error(`Ark Image API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error(`No image found in Ark response: ${JSON.stringify(data).slice(0, 300)}`);
    return Buffer.from(b64, "base64");
  }
}

/** Text-to-image. Returns a PNG buffer. */
export async function arkGenerateImage(prompt, { baseUrl, apiKey, model, aspectRatio, imageSize, signal }) {
  const buf = await postArk({
    baseUrl, apiKey, model, signal,
    body: { prompt, size: resolveArkSize(parseAspect(aspectRatio), imageSize) },
  });
  return sharp(buf).png().toBuffer();
}

/**
 * Image editing with a reference image. Output is resized back to the source
 * dimensions, since downstream steps read overlay coordinates in source pixels.
 */
export async function arkEditImage(text, imageBuffer, { baseUrl, apiKey, model, imageSize, signal }) {
  const { width, height } = await sharp(imageBuffer).metadata();
  const buf = await postArk({
    baseUrl, apiKey, model, signal,
    body: {
      prompt: text,
      image: `data:image/png;base64,${imageBuffer.toString("base64")}`,
      size: resolveArkSize(width / height, imageSize),
    },
  });
  return sharp(buf).resize(width, height, { fit: "fill" }).png().toBuffer();
}
