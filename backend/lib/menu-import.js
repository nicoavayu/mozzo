const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { Jimp } = require('jimp');
const Tesseract = require('tesseract.js');

const PRICE_HINT_PATTERN = /(?:\$|s\/)?\s*\d{1,4}(?:[.,]\d{1,2})?\s*$/i;
const SHARPEN_KERNEL = [
  [0, -1, 0],
  [-1, 5, -1],
  [0, -1, 0],
];
const PREVIEW_MAX_WIDTH = 720;

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBbox(bbox = {}) {
  return {
    x0: Number(bbox.x0 || 0),
    y0: Number(bbox.y0 || 0),
    x1: Number(bbox.x1 || 0),
    y1: Number(bbox.y1 || 0),
  };
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function extractLinesFromBlocks(blocks = []) {
  const lines = [];

  blocks.forEach((block, blockIndex) => {
    (block.paragraphs || []).forEach((paragraph, paragraphIndex) => {
      (paragraph.lines || []).forEach((line, lineIndex) => {
        const text = normalizeText(line.text);

        if (!text) {
          return;
        }

        const bbox = normalizeBbox(line.bbox);
        const words = (line.words || [])
          .map((word) => ({
            text: normalizeText(word.text),
            confidence: Number(word.confidence || 0),
            bbox: normalizeBbox(word.bbox),
          }))
          .filter((word) => word.text);

        lines.push({
          block_index: blockIndex,
          paragraph_index: paragraphIndex,
          line_index: lineIndex,
          block_type: block.blocktype || 'unknown',
          text,
          confidence: Number(line.confidence || block.confidence || 0),
          bbox,
          row_height: Number(line.rowAttributes?.rowHeight || Math.max(bbox.y1 - bbox.y0, 0)),
          words,
        });
      });
    });
  });

  return lines.sort((left, right) => {
    if (left.block_index !== right.block_index) {
      return left.block_index - right.block_index;
    }

    if (left.bbox.y0 !== right.bbox.y0) {
      return left.bbox.y0 - right.bbox.y0;
    }

    return left.bbox.x0 - right.bbox.x0;
  });
}

function findContentBounds(image, brightnessThreshold = 246) {
  const { width, height, data } = image.bitmap;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  image.scan(0, 0, width, height, (x, y, idx) => {
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const a = data[idx + 3];
    const brightness = (r + g + b) / 3;
    const contrast = Math.max(r, g, b) - Math.min(r, g, b);

    if (a > 16 && (brightness < brightnessThreshold || contrast > 12)) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  });

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

function cropToContent(image) {
  const bounds = findContentBounds(image);

  if (!bounds) {
    return null;
  }

  const padding = 28;
  const x = Math.max(0, bounds.minX - padding);
  const y = Math.max(0, bounds.minY - padding);
  const w = Math.min(
    image.bitmap.width - x,
    bounds.maxX - bounds.minX + (padding * 2) + 1
  );
  const h = Math.min(
    image.bitmap.height - y,
    bounds.maxY - bounds.minY + (padding * 2) + 1
  );

  image.crop({ x, y, w, h });

  return { x, y, w, h };
}

function scaleImage(image) {
  const { width } = image.bitmap;

  if (width >= 1400 && width <= 2200) {
    return 1;
  }

  if (width < 1400) {
    const factor = 1600 / Math.max(width, 1);
    image.resize({
      w: Math.round(image.bitmap.width * factor),
      h: Math.round(image.bitmap.height * factor),
    });
    return factor;
  }

  const factor = 2200 / width;
  image.resize({
    w: Math.round(image.bitmap.width * factor),
    h: Math.round(image.bitmap.height * factor),
  });
  return factor;
}

function applyBinaryThreshold(image, limit = 212) {
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, (x, y, idx) => {
    const value = image.bitmap.data[idx];
    const nextValue = value < limit ? 0 : 255;
    image.bitmap.data[idx] = nextValue;
    image.bitmap.data[idx + 1] = nextValue;
    image.bitmap.data[idx + 2] = nextValue;
  });

  return image;
}

async function writeCandidateImage(image, label) {
  const candidatePath = path.join(os.tmpdir(), `mozzo-menu-import-${label}-${randomUUID()}.png`);
  await image.write(candidatePath);
  return candidatePath;
}

async function buildPreviewDataUrl(imagePath) {
  const previewImage = await Jimp.read(imagePath);

  if (previewImage.bitmap.width > PREVIEW_MAX_WIDTH) {
    const scale = PREVIEW_MAX_WIDTH / previewImage.bitmap.width;
    previewImage.resize({
      w: PREVIEW_MAX_WIDTH,
      h: Math.max(1, Math.round(previewImage.bitmap.height * scale)),
    });
  }

  return previewImage.getBase64('image/png');
}

async function buildCandidateImages(imagePath) {
  const candidates = [
    {
      name: 'original',
      path: imagePath,
      preprocessing: {
        applied: false,
        steps: [],
        scale: 1,
        crop: null,
      },
    },
  ];
  const cleanupPaths = [];

  try {
    const baseImage = await Jimp.read(imagePath);
    const enhancedImage = baseImage.clone();
    const crop = cropToContent(enhancedImage);
    const scale = scaleImage(enhancedImage);
    const steps = [];

    if (crop) {
      steps.push('autocrop_whitespace');
    }

    if (Math.abs(scale - 1) > 0.01) {
      steps.push(scale > 1 ? `upscale_${scale.toFixed(2)}x` : `downscale_${scale.toFixed(2)}x`);
    }

    enhancedImage
      .greyscale()
      .normalize()
      .contrast(0.25)
      .convolute(SHARPEN_KERNEL);

    steps.push('grayscale', 'normalize', 'contrast', 'sharpen');

    const enhancedPath = await writeCandidateImage(enhancedImage, 'enhanced');
    cleanupPaths.push(enhancedPath);
    candidates.push({
      name: 'enhanced',
      path: enhancedPath,
      preprocessing: {
        applied: true,
        steps,
        scale,
        crop,
      },
    });

    const thresholdedImage = applyBinaryThreshold(enhancedImage.clone(), 212);
    const thresholdedPath = await writeCandidateImage(thresholdedImage, 'thresholded');
    cleanupPaths.push(thresholdedPath);
    candidates.push({
      name: 'enhanced-threshold',
      path: thresholdedPath,
      preprocessing: {
        applied: true,
        steps: [...steps, 'binary_threshold_212'],
        scale,
        crop,
      },
    });
  } catch (error) {
    console.warn('Menu image preprocessing skipped:', error.message);
  }

  return { candidates, cleanupPaths };
}

function countPriceLikeLines(lines = []) {
  return lines.filter((line) => PRICE_HINT_PATTERN.test(line.text)).length;
}

function buildPageBounds(lines) {
  return lines.reduce(
    (bounds, line) => ({
      width: Math.max(bounds.width, line.bbox.x1),
      height: Math.max(bounds.height, line.bbox.y1),
    }),
    { width: 0, height: 0 }
  );
}

function scoreOcrPayload(payload) {
  const avgLineConfidence = average(payload.lines.map((line) => line.confidence));
  const usefulLines = payload.lines.filter((line) => /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(line.text)).length;
  const descriptionLikeLines = payload.lines.filter((line) => normalizeText(line.text).split(' ').length >= 4).length;

  return Number(
    (
      (payload.confidence * 1.45) +
      (avgLineConfidence * 0.7) +
      (usefulLines * 1.5) +
      (countPriceLikeLines(payload.lines) * 4) +
      (descriptionLikeLines * 0.55)
    ).toFixed(2)
  );
}

async function recognizeCandidate(worker, candidate) {
  const { data } = await worker.recognize(
    candidate.path,
    { rotateAuto: true },
    {
      text: true,
      blocks: true,
    }
  );

  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  const lines = extractLinesFromBlocks(blocks);
  const averageLineConfidence = Number(average(lines.map((line) => line.confidence)).toFixed(2));

  return {
    text: data.text || '',
    confidence: Number(data.confidence || 0),
    rotate_radians: Number(data.rotateRadians || 0),
    page: buildPageBounds(lines),
    lines,
    average_line_confidence: averageLineConfidence,
    price_like_lines: countPriceLikeLines(lines),
    ocr_variant: candidate.name,
    preprocessing: candidate.preprocessing,
  };
}

async function extractStructuredMenuOcr(imagePath) {
  const worker = await Tesseract.createWorker('spa');
  const { candidates, cleanupPaths } = await buildCandidateImages(imagePath);

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: '11',
      preserve_interword_spaces: '1',
      user_defined_dpi: '180',
    });

    const payloads = [];
    for (const candidate of candidates) {
      const payload = await recognizeCandidate(worker, candidate);
      payload.ocr_score = scoreOcrPayload(payload);
      payloads.push(payload);
    }

    payloads.sort((left, right) => right.ocr_score - left.ocr_score);
    const bestPayload = payloads[0];
    const previewImages = await Promise.all(
      candidates.map(async (candidate) => ({
        name: candidate.name,
        data_url: await buildPreviewDataUrl(candidate.path),
      }))
    );

    return {
      text: bestPayload.text,
      confidence: bestPayload.confidence,
      rotate_radians: bestPayload.rotate_radians,
      page: bestPayload.page,
      lines: bestPayload.lines,
      preprocessing: {
        selected: bestPayload.ocr_variant,
        applied_steps: bestPayload.preprocessing.steps,
        scale: bestPayload.preprocessing.scale,
        crop: bestPayload.preprocessing.crop,
        candidates: payloads.map((payload) => ({
          name: payload.ocr_variant,
          score: payload.ocr_score,
          confidence: payload.confidence,
          average_line_confidence: payload.average_line_confidence,
          line_count: payload.lines.length,
          price_like_lines: payload.price_like_lines,
          selected: payload.ocr_variant === bestPayload.ocr_variant,
        })),
        preview_images: previewImages,
      },
    };
  } finally {
    await worker.terminate();

    for (const cleanupPath of cleanupPaths) {
      if (fs.existsSync(cleanupPath)) {
        fs.unlinkSync(cleanupPath);
      }
    }
  }
}

module.exports = {
  extractStructuredMenuOcr,
};
