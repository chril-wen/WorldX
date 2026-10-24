/**
 * Image generation client — OpenAI-compatible chat completions with image output.
 * Reads IMAGE_GEN_* env vars. Default: OpenRouter + gemini-3.1-flash-image-preview.
 */

import dotenv from "dotenv";
import sharp from "sharp";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logModelCall, logModelResponse, logModelImageResponse, logError } from "../utils/logger.mjs";
import { getMapImageSizeLabel } from "../utils/generation-config.mjs";
import { isArkProvider, arkGenerateImage, arkEditImage, arkOutpaintImage } from "../../../shared/ark-seedream.mjs";
import {
  isOpenAiImagesProvider,
  openAiGenerateImage,
  openAiEditImage,
} from "../../../shared/openai-images.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../../../../.env") });

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview";
const MODEL = process.env.IMAGE_GEN_MODEL || DEFAULT_MODEL;
const BASE_URL = process.env.IMAGE_GEN_BASE_URL || DEFAULT_BASE_URL;
const PROVIDER = (process.env.IMAGE_GEN_PROVIDER || "").trim().toLowerCase();
const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.IMAGE_GEN_TIMEOUT_MS || "180000", 10);
const MAX_CONSECUTIVE_FAILURES = 2;

async function withRetry(fn, logStep) {
  for (let attempt = 1; attempt <= MAX_CONSECUTIVE_FAILURES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[${logStep}] Attempt ${attempt} failed (${e.message}), retrying...`);
        continue;
      }
      throw e;
    }
  }
}

function resolveRequestTimeoutMs(requestTimeoutMs, timeoutEnvKey) {
  if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
    return requestTimeoutMs;
  }

  if (timeoutEnvKey && process.env[timeoutEnvKey]) {
    const parsed = parseInt(process.env[timeoutEnvKey], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_REQUEST_TIMEOUT_MS;
}

function useGoogleNativeProvider() {
  return (
    PROVIDER === "google-native" ||
    PROVIDER === "google" ||
    (!PROVIDER && BASE_URL.includes("generativelanguage.googleapis.com"))
  );
}

/**
 * 文生图时的目标尺寸。
 *
 * OpenAI Images API 接受任意 WxH（不限于固定的几档预设），实测
 * 1536x1024 / 1920x720 / 1536x576 / 2048x768 / 2560x720 都能原样返回。
 * 所以这里按【精确宽高比】计算，避免模型重采样时改变构图。
 */
function openAiSizeForAspect(aspectRatio, imageSize) {
  const aspect = (() => {
    const [w, h] = String(aspectRatio || "16:9").split(":").map(Number);
    return w > 0 && h > 0 ? w / h : 16 / 9;
  })();

  const LONG_EDGE = (() => {
    const k = parseInt(String(imageSize || "1K").toUpperCase().replace("K", ""), 10);
    return (Number.isFinite(k) && k > 0 ? k : 1) * 1024;
  })();

  // 长边 = imageSize，短边按比例。宽高都取 16 的倍数（模型偏好）。
  const long = Math.min(LONG_EDGE, 4096);
  const short = Math.round(long / aspect / 16) * 16;
  const w = aspect >= 1 ? long : short;
  const h = aspect >= 1 ? short : long;
  return `${w}x${h}`;
}

function getGoogleNativeBaseUrl() {
  const trimmed = BASE_URL.replace(/\/+$/, "");
  return trimmed.endsWith("/openai")
    ? trimmed.slice(0, -"/openai".length)
    : trimmed;
}

function getGoogleNativeModel() {
  return MODEL.replace(/^google\//, "").replace(/^models\//, "");
}

function buildGoogleNativeUrl(apiKey) {
  const model = encodeURIComponent(getGoogleNativeModel());
  return `${getGoogleNativeBaseUrl()}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function buildGoogleNativeBody(parts) {
  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };
}

async function postGoogleNativeImage(parts, { apiKey, signal }) {
  return fetch(buildGoogleNativeUrl(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildGoogleNativeBody(parts)),
    signal,
  });
}

/**
 * Text-to-image generation.
 * @returns {Buffer} PNG image buffer
 */
export async function generateImage(
  prompt,
  { aspectRatio = "16:9", imageSize = getMapImageSizeLabel(), logStep = "flash-img-gen", requestTimeoutMs, timeoutEnvKey, referenceImage, maskImage } = {},
) {
  return withRetry(async () => {
    const API_KEY = process.env.IMAGE_GEN_API_KEY || "";
    const mode = maskImage ? "outpaint" : referenceImage ? "edit" : "text-to-image";
    logModelCall(logStep, MODEL, prompt, [`config: aspect=${aspectRatio}, size=${imageSize}, mode=${mode}`]);
    const timeoutMs = resolveRequestTimeoutMs(requestTimeoutMs, timeoutEnvKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // OpenAI Images API 的 size 必须与参考图尺寸一致，否则模型会重采样整张图，
    // 把本该锁定的旧区内容改写掉。
    let referenceSize;
    if (referenceImage) {
      const meta = await sharp(referenceImage).metadata();
      referenceSize = `${meta.width}x${meta.height}`;
    }

    try {
      if (isOpenAiImagesProvider(PROVIDER, BASE_URL)) {
        // OpenAI Images API：/images/generations 与 /images/edits。
        // size 必须与画布一致，否则模型会重采样整张图，旧区内容会被改写。
        let buf;
        if (maskImage) {
          // Outpainting: canvas + mask。mask 语义在 openai-images 内部转换
          // （项目用灰度 255=生成，OpenAI 用 alpha 透明=生成）。
          buf = await openAiEditImage(prompt, referenceImage, {
            baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL,
            maskBuffer: maskImage,
            size: referenceSize,
            signal: controller.signal,
          });
        } else if (referenceImage) {
          buf = await openAiEditImage(prompt, referenceImage, {
            baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL,
            size: referenceSize,
            signal: controller.signal,
          });
        } else {
          buf = await openAiGenerateImage(prompt, {
            baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL,
            size: openAiSizeForAspect(aspectRatio, imageSize),
            signal: controller.signal,
          });
        }
        logModelImageResponse(logStep, MODEL, "(returned to caller)", buf.length);
        return buf;
      }

      if (isArkProvider(PROVIDER, BASE_URL)) {
        let buf;
        if (maskImage) {
          // Outpainting: canvas + mask. The model keeps masked-out pixels and
          // regenerates the masked region in context.
          buf = await arkOutpaintImage(prompt, referenceImage, maskImage, {
            baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL, imageSize, signal: controller.signal,
          });
        } else if (referenceImage) {
          buf = await arkEditImage(prompt, referenceImage, {
            baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL, imageSize, signal: controller.signal,
          });
        } else {
          buf = await arkGenerateImage(prompt, {
            baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL, aspectRatio, imageSize, signal: controller.signal,
          });
        }
        logModelImageResponse(logStep, MODEL, "(returned to caller)", buf.length);
        return buf;
      }

      const nativePrompt = useGoogleNativeProvider()
        ? `${prompt}\n\nGenerate the image in ${aspectRatio} aspect ratio.`
        : prompt;
      const res = useGoogleNativeProvider()
        ? await postGoogleNativeImage(
            referenceImage
              ? [
                  { text: nativePrompt },
                  { inlineData: { mimeType: "image/png", data: referenceImage.toString("base64") } },
                ]
              : [{ text: nativePrompt }],
            {
              apiKey: API_KEY,
              signal: controller.signal,
            }
          )
        : await fetch(`${BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: MODEL,
              messages: [
                {
                  role: "user",
                  content: referenceImage
                    ? [
                        { type: "text", text: prompt },
                        {
                          type: "image_url",
                          image_url: { url: `data:image/png;base64,${referenceImage.toString("base64")}` },
                        },
                        ...(maskImage
                          ? [
                              {
                                type: "image_url",
                                image_url: { url: `data:image/png;base64,${maskImage.toString("base64")}` },
                              },
                            ]
                          : []),
                      ]
                    : prompt,
                },
              ],
              modalities: ["image", "text"],
              image_config: { aspect_ratio: aspectRatio, image_size: imageSize },
            }),
            signal: controller.signal,
          });

      if (!res.ok) {
        const err = await res.text();
        const error = new Error(`Image Gen API error ${res.status}: ${err}`);
        logError(logStep, error);
        throw error;
      }

      const data = await res.json();
      const buf = useGoogleNativeProvider()
        ? extractGoogleNativeImageBuffer(data)
        : extractImageBuffer(data);
      logModelImageResponse(logStep, MODEL, "(returned to caller)", buf.length);
      return buf;
    } catch (e) {
      if (e.name === "AbortError") {
        const error = new Error(`Image Gen request timed out after ${timeoutMs / 1000}s`);
        logError(logStep, error);
        throw error;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }, logStep);
}

/**
 * Image editing: pass an existing image + text instruction → modified image.
 * @param {string} text  - editing instruction
 * @param {Buffer} imageBuffer - source image
 * @returns {Buffer} PNG image buffer
 */
export async function editImage(text, imageBuffer, { imageSize = "2K", logStep = "flash-img-edit", requestTimeoutMs, timeoutEnvKey } = {}) {
  return withRetry(async () => {
    const API_KEY = process.env.IMAGE_GEN_API_KEY || "";
    logModelCall(logStep, MODEL, text, [`input_image: ${(imageBuffer.length / 1024).toFixed(0)}KB`, `config: size=${imageSize}`]);
    const timeoutMs = resolveRequestTimeoutMs(requestTimeoutMs, timeoutEnvKey);

    const base64 = imageBuffer.toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (isOpenAiImagesProvider(PROVIDER, BASE_URL)) {
        const meta = await sharp(imageBuffer).metadata();
        const buf = await openAiEditImage(text, imageBuffer, {
          baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL,
          size: `${meta.width}x${meta.height}`,
          signal: controller.signal,
        });
        logModelImageResponse(logStep, MODEL, "(returned to caller)", buf.length);
        return buf;
      }

      if (isArkProvider(PROVIDER, BASE_URL)) {
        const buf = await arkEditImage(text, imageBuffer, {
          baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL, imageSize, signal: controller.signal,
        });
        logModelImageResponse(logStep, MODEL, "(returned to caller)", buf.length);
        return buf;
      }

      const res = useGoogleNativeProvider()
        ? await postGoogleNativeImage(
            [
              { text },
              { inlineData: { mimeType: "image/png", data: base64 } },
            ],
            {
              apiKey: API_KEY,
              signal: controller.signal,
            },
          )
        : await fetch(`${BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: MODEL,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text },
                    {
                      type: "image_url",
                      image_url: { url: `data:image/png;base64,${base64}` },
                    },
                  ],
                },
              ],
              modalities: ["image", "text"],
              image_config: { image_size: imageSize },
            }),
            signal: controller.signal,
          });

      if (!res.ok) {
        const err = await res.text();
        const error = new Error(`Image Gen Edit API error ${res.status}: ${err}`);
        logError(logStep, error);
        throw error;
      }

      const data = await res.json();
      const buf = useGoogleNativeProvider()
        ? extractGoogleNativeImageBuffer(data)
        : extractImageBuffer(data);
      logModelImageResponse(logStep, MODEL, "(returned to caller)", buf.length);
      return buf;
    } catch (e) {
      if (e.name === "AbortError") {
        const error = new Error(`Image Gen Edit request timed out after ${timeoutMs / 1000}s`);
        logError(logStep, error);
        throw error;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }, logStep);
}

function extractImageBuffer(data) {
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("No message in Image Gen response");

  if (message.images && message.images.length > 0) {
    const url = message.images[0].image_url.url;
    const b64 = url.replace(/^data:image\/\w+;base64,/, "");
    return Buffer.from(b64, "base64");
  }

  if (message.content && typeof message.content === "string") {
    const match = message.content.match(/data:image\/\w+;base64,([A-Za-z0-9+/=]+)/);
    if (match) return Buffer.from(match[1], "base64");
  }

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        const b64 = url.replace(/^data:image\/\w+;base64,/, "");
        if (b64) return Buffer.from(b64, "base64");
      }
    }
  }

  throw new Error("No image found in Image Gen response");
}

function extractGoogleNativeImageBuffer(data) {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate.content?.parts)
      ? candidate.content.parts
      : [];
    for (const part of parts) {
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        return Buffer.from(inlineData.data, "base64");
      }
    }
  }

  throw new Error("No image found in Google native Image Gen response");
}
