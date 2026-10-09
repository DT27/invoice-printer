// layout-engine.cjs - 核心排版引擎（主进程 CommonJS，require pdf-lib）
const { PDFDocument, degrees } = require('pdf-lib');
const fs = require('fs');

const PAPER_SIZES = {
  A4: { width: 210 * 2.83464567, height: 297 * 2.83464567 },
  A5: { width: 148 * 2.83464567, height: 210 * 2.83464567 }
};

const TEMPLATE_GRID = {
  A4_1:  { rows: 1, cols: 1 },
  A4_2H: { rows: 2, cols: 1 },
  A4_2V: { rows: 1, cols: 2 },
  A4_3H: { rows: 3, cols: 1 },
  A4_4:  { rows: 2, cols: 2 },
  A5_1:  { rows: 1, cols: 1 }
};

const MM_TO_PT = 2.83464567;

/**
 * 排版发票
 * @param {Object} opts
 * @param {Array} opts.files - [{ path, name, ext, buffer }]
 * @param {string} opts.template
 * @param {string} opts.paper
 * @param {Object} opts.margins - { top, right, bottom, left } mm
 * @param {number} opts.scale - %
 * @returns {Promise<Buffer>} 排版后 PDF
 */
async function layoutInvoices({ files, template, paper, margins, scale }) {
  if (!files || files.length === 0) throw new Error('没有待打印的文件');

  const grid = TEMPLATE_GRID[template] || TEMPLATE_GRID.A4_1;
  const paperSize = PAPER_SIZES[paper] || PAPER_SIZES.A4;
  const scaleFactor = (scale || 100) / 100;

  const mg = {
    top: ((margins && margins.top) ?? 5) * MM_TO_PT,
    right: ((margins && margins.right) ?? 5) * MM_TO_PT,
    bottom: ((margins && margins.bottom) ?? 5) * MM_TO_PT,
    left: ((margins && margins.left) ?? 5) * MM_TO_PT
  };

  const outDoc = await PDFDocument.create();
  const allItems = [];

  for (const f of files) {
    const buf = Buffer.isBuffer(f.buffer) ? f.buffer : Buffer.from(f.buffer);
    if (f.ext === '.pdf') {
      const srcDoc = await PDFDocument.load(buf);
      for (const page of srcDoc.getPages()) {
        // CropBox 是阅读器实际显示区域；用它做嵌入框可精确还原图面
        const crop = page.getCropBox(); // { x, y, width, height }
        // /Rotate 会改变观感方向（pdf-lib 嵌入时忽略它，需自行补偿）
        const angle = ((page.getRotation().angle % 360) + 360) % 360;
        const swap = angle === 90 || angle === 270;
        const dispW = swap ? crop.height : crop.width;
        const dispH = swap ? crop.width : crop.height;
        allItems.push({
          type: 'pdf',
          page,
          rot: angle,
          box: { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height },
          origW: dispW,
          origH: dispH
        });
      }
    } else if (f.ext === '.png') {
      const pngImage = await outDoc.embedPng(new Uint8Array(buf));
      allItems.push({
        type: 'png',
        pngImage,
        origW: pngImage.width,
        origH: pngImage.height
      });
    }
  }

  if (allItems.length === 0) throw new Error('没有可排版的内容');

  const rowH = (paperSize.height - mg.top - mg.bottom) / grid.rows;
  const colW = (paperSize.width - mg.left - mg.right) / grid.cols;

  let outPage = outDoc.addPage([paperSize.width, paperSize.height]);
  let curCol = 0, curRow = 0;

  for (let idx = 0; idx < allItems.length; idx++) {
    const item = allItems[idx];
    const fit = fitIntoCell(item.origW, item.origH, colW, rowH, scaleFactor);
    const offsetX = (colW - fit.w) / 2;
    const offsetY = (rowH - fit.h) / 2;
    const x = mg.left + curCol * colW + offsetX;
    const y = paperSize.height - mg.top - curRow * rowH - fit.h - offsetY;

    if (item.type === 'pdf') {
      // 显式传入 CropBox + 平移矩阵，把非零原点的 MediaBox/CropBox 内容归零，
      // 修复 pdf-lib 默认嵌入时丢弃原点导致图面整体偏移、顶部被裁的问题
      const embeddedPage = await outDoc.embedPage(
        item.page,
        item.box,
        [1, 0, 0, 1, -item.box.left, -item.box.bottom]
      );
      // fit.w/fit.h 是目标显示尺寸（观感方向）；按旋转角换算 drawPage 锚点与缩放
      let opts;
      switch (item.rot) {
        case 90:  opts = { x: x + fit.w, y, width: fit.h, height: fit.w, rotate: degrees(90) }; break;
        case 270: opts = { x, y: y + fit.h, width: fit.w, height: fit.h, rotate: degrees(270) }; break;
        case 180: opts = { x: x + fit.w, y: y + fit.h, width: fit.w, height: fit.h, rotate: degrees(180) }; break;
        default:  opts = { x, y, width: fit.w, height: fit.h };
      }
      outPage.drawPage(embeddedPage, opts);
    } else {
      outPage.drawImage(item.pngImage, { x, y, width: fit.w, height: fit.h });
    }

    // 移动到下一格；当前页放满则新建页（但仅在还有剩余发票时才建）
    curCol++;
    if (curCol >= grid.cols) {
      curCol = 0;
      curRow++;
      if (curRow >= grid.rows && idx < allItems.length - 1) {
        outPage = outDoc.addPage([paperSize.width, paperSize.height]);
        curRow = 0;
      }
    }
  }

  const bytes = await outDoc.save();
  return bytes;
}

function fitIntoCell(origW, origH, cellW, cellH, scaleFactor) {
  const sw = origW * scaleFactor;
  const sh = origH * scaleFactor;
  const ratio = Math.min(cellW / sw, cellH / sh, 1);
  return { w: sw * ratio, h: sh * ratio };
}

module.exports = { layoutInvoices, PAPER_SIZES, TEMPLATE_GRID };
