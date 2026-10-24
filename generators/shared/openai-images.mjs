/**
 * OpenAI 兼容的 Images API 客户端（gpt-image 系列）。
 *
 * 走 /v1/images/generations 与 /v1/images/edits，与 Ark/Seedream 是两套协议：
 *   - Ark：JSON body，图片是 base64 data URL，mask 是【灰度】（255 = 重绘）
 *   - OpenAI：multipart form-data，mask 是【alpha】（透明 = 重绘）
 *
 * 关键点：
 *   1. mask 语义不同，必须转换。项目的 mask 是灰度（0=锁定，255=生成），
 *      直接丢给 OpenAI 会反着来——把该保留的旧图重绘掉。
 *   2. input_fidelity=high 让模型严格保留 mask 之外的部分。
 *      不加这个参数时模型会重绘整张图，扩图的旧图就没了。
 *   3. size 可以传任意 WxH，但必须与画布一致，否则模型会重采样整张图。
 */

import sharp from "sharp";

const RETRY_DELAYS_MS = [8000, 15000, 25000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export function isOpenAiImagesProvider(provider, baseUrl) {
  if (provider === "openai-images" || provider === "gpt-image") return true;
  if (provider) return false;
  return /kemuapi|api\.openai\.com|openai/i.test(String(baseUrl || ""));
}

/** 把项目的灰度 mask（0=锁定，255=生成）转成 OpenAI 要的 alpha mask（透明=重绘）。 */
export async function grayscaleMaskToAlpha(maskBuffer) {
  const { width, height } = await sharp(maskBuffer).metadata();
  const raw = await sharp(maskBuffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const grey = raw.data[i];
    // 灰度 255 = 要生成 = alpha 0（透明区域会被重绘）
    out[i * 4] = 0;
    out[i * 4 + 1] = 0;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255 - grey;
  }

  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function postMultipart(url, { apiKey, fields, files, signal }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, String(value));
  }
  for (const [key, buffer] of Object.entries(files)) {
    if (!buffer) continue;
    form.append(key, new Blob([buffer], { type: "image/png" }), `${key}.png`);
  }

  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });

      if (!res.ok) {
        const text = await res.text();
        const error = new Error(`Image API error ${res.status}: ${text.slice(0, 400)}`);
        error.status = res.status;
        // 4xx（除 429）是请求本身有问题，重试没有意义
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw error;
        throw error;
      }

      const data = await res.json();
      const item = data?.data?.[0];
      if (!item) throw new Error(`Empty image response: ${JSON.stringify(data).slice(0, 300)}`);

      if (item.b64_json) return Buffer.from(item.b64_json, "base64");
      if (item.url) {
        const imgRes = await fetch(item.url, { signal });
        if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
        return Buffer.from(await imgRes.arrayBuffer());
      }
      throw new Error("Image response has neither b64_json nor url");
    } catch (err) {
      lastError = err;
      const status = Number(err?.status ?? 0);
      // 客户端错误直接抛出，不重试
      if (status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt === MAX_ATTEMPTS - 1) break;
      const wait = RETRY_DELAYS_MS[attempt] ?? 25000;
      console.warn(
        `[openai-images] attempt ${attempt + 1} failed (${err.message}), retrying in ${wait / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError ?? new Error("Image request failed");
}

/**
 * 文生图。
 *
 * 注意：/images/generations 必须用 JSON body。
 * 用 multipart 传 model 时服务端会忽略该字段并回退到默认模型（dall-e），
 * 导致 "No available channel for model dall-e" 的 503。
 */
export async function openAiGenerateImage(
  prompt,
  { baseUrl, apiKey, model, size = "1536x1024", signal, quality },
) {
  const body = {
    model,
    prompt,
    size,
    response_format: "b64_json",
  };
  if (quality) body.quality = quality;

  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text();
        const error = new Error(`Image API error ${res.status}: ${text.slice(0, 400)}`);
        error.status = res.status;
        throw error;
      }
      const data = await res.json();
      const item = data?.data?.[0];
      if (!item) throw new Error(`Empty image response: ${JSON.stringify(data).slice(0, 300)}`);
      if (item.b64_json) return Buffer.from(item.b64_json, "base64");
      if (item.url) {
        const imgRes = await fetch(item.url, { signal });
        if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
        return Buffer.from(await imgRes.arrayBuffer());
      }
      throw new Error("Image response has neither b64_json nor url");
    } catch (err) {
      lastError = err;
      const status = Number(err?.status ?? 0);
      if (status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt === MAX_ATTEMPTS - 1) break;
      const wait = RETRY_DELAYS_MS[attempt] ?? 25000;
      console.warn(
        `[openai-images] attempt ${attempt + 1} failed (${err.message}), retrying in ${wait / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError ?? new Error("Image generation failed");
}

/**
 * 参考图编辑（可选 mask）。
 *
 * maskBuffer 必须是项目的灰度 mask（0=锁定，255=生成），
 * 内部会转换成 OpenAI 的 alpha 语义。
 */
export async function openAiEditImage(
  prompt,
  imageBuffer,
  { baseUrl, apiKey, model, maskBuffer, size, signal, inputFidelity = "high" },
) {
  const meta = await sharp(imageBuffer).metadata();
  const targetSize = size || `${meta.width}x${meta.height}`;

  const files = { image: imageBuffer };
  const fields = {
    model,
    prompt,
    size: targetSize,
    response_format: "b64_json",
  };
  if (inputFidelity) fields.input_fidelity = inputFidelity;

  if (maskBuffer) {
    files.mask = await grayscaleMaskToAlpha(maskBuffer);
  }

  return postMultipart(`${baseUrl.replace(/\/+$/, "")}/images/edits`, {
    apiKey,
    fields,
    files,
    signal,
  });
}
