import { createCanvas, loadImage } from '@napi-rs/canvas';

export default async function generateGrid(imageUrls) {
  const size = 150;
  const cols = Math.ceil(Math.sqrt(imageUrls.length));
  const rows = Math.ceil(imageUrls.length / cols);
  const canvas = createCanvas(cols * size, rows * size);
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const img = await loadImage(imageUrls[i]);
      const x = (i % cols) * size;
      const y = Math.floor(i / cols) * size;
      ctx.drawImage(img, x, y, size, size);
    } catch (e) {
      console.warn(`Couldn't load image: ${imageUrls[i]}`);
    }
  }

  return canvas.toBuffer('image/png');
}
