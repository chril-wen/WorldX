/**
 * 色彩匹配：把新地图块的色调统计量对齐到旧地图。
 *
 * 在 RGB 空间做 Reinhard 变换：
 *   out = (src - srcMean) * (refStd / srcStd) + refMean
 *
 * 注意：不要在 Lab 的 a/b 通道上做这个变换——那两个通道是以 128 为中心的
 * 有符号值，按「以 0 为中心」处理再 clamp 会把饱和度压成 0，画面变成黑红。
 */
import sharp from "sharp";

/** 计算图片在 RGB 空间的通道统计量 */
async function rgbStats(buffer) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const n = info.width * info.height;
  const mean = new Float64Array(ch);
  const std = new Float64Array(ch);

  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) mean[c] += data[i * ch + c];
  }
  for (let c = 0; c < ch; c++) mean[c] /= n;

  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const d = data[i * ch + c] - mean[c];
      std[c] += d * d;
    }
  }
  for (let c = 0; c < ch; c++) std[c] = Math.sqrt(std[c] / n) || 1;

  return { data, info, mean, std };
}

/**
 * 把 src 的色调统计量匹配到 ref 的统计量。
 *
 * @param {Buffer} src - 待调整的图片
 * @param {Buffer} ref - 参考图片（色彩基准）
 * @param {number} strength - 匹配强度 0~1
 * @returns {Promise<Buffer>} 调整后的 PNG
 */
export async function matchColorToReference(src, ref, strength = 1) {
  const s = await rgbStats(src);
  const r = await rgbStats(ref);
  const out = Buffer.alloc(s.data.length);

  for (let i = 0; i < s.data.length; i++) {
    const c = i % s.info.channels;
    // 中心化后按标准差比例缩放，再平移到 ref 的均值
    const centered = s.data[i] - s.mean[c];
    const scaled = centered * (r.std[c] / s.std[c]);
    const matched = scaled + r.mean[c];
    // strength 在【原图】和【匹配结果】之间插值
    out[i] = Math.max(0, Math.min(255, Math.round(s.data[i] * (1 - strength) + matched * strength)));
  }

  return sharp(out, {
    raw: { width: s.info.width, height: s.info.height, channels: s.info.channels },
  })
    .png()
    .toBuffer();
}
