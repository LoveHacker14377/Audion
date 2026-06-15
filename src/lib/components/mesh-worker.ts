let canvas: OffscreenCanvas;
let ctx: OffscreenCanvasRenderingContext2D;
const SIZE = 48;

let currentColors: number[][] = [
  [10, 10, 10], [10, 10, 10], [10, 10, 10], [10, 10, 10],
];
let targetColors = currentColors.map((c) => [...c]);
let transitionStart = 0;
const TRANSITION_MS = 600;

function hexToRgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function draw(time: number) {
  const t = time * 0.00028;

  const fadeT = Math.min(1, (time - transitionStart) / TRANSITION_MS);
  const easeT = fadeT < 1 ? 1 - Math.pow(1 - fadeT, 3) : 1;
  const colors = currentColors.map((c, i) => [
    lerp(c[0], targetColors[i][0], easeT),
    lerp(c[1], targetColors[i][1], easeT),
    lerp(c[2], targetColors[i][2], easeT),
  ]);
  if (fadeT >= 1) currentColors = colors.map((c) => [...c]);

  const points = [
    { x: 0.25 + 0.22 * Math.sin(t * 1.0), y: 0.25 + 0.22 * Math.cos(t * 1.3) },
    { x: 0.75 + 0.22 * Math.cos(t * 0.8), y: 0.25 + 0.22 * Math.sin(t * 1.1) },
    { x: 0.25 + 0.22 * Math.sin(t * 1.2), y: 0.75 + 0.22 * Math.cos(t * 0.9) },
    { x: 0.75 + 0.22 * Math.cos(t * 1.4), y: 0.75 + 0.22 * Math.sin(t * 0.7) },
  ];

  const imageData = ctx.createImageData(SIZE, SIZE);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const x = px / SIZE;
      const y = py / SIZE;

      let totalWeight = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < 4; i++) {
        const dx = x - points[i].x;
        const dy = y - points[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const weight = 1 / Math.pow(dist, 3.5);
        totalWeight += weight;
        r += colors[i][0] * weight;
        g += colors[i][1] * weight;
        b += colors[i][2] * weight;
      }

      const idx = (py * SIZE + px) * 4;
      imageData.data[idx] = r / totalWeight;
      imageData.data[idx + 1] = g / totalWeight;
      imageData.data[idx + 2] = b / totalWeight;
      imageData.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  requestAnimationFrame(draw);
}

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === "init") {
    canvas = e.data.canvas;
    canvas.width = SIZE;
    canvas.height = SIZE;
    ctx = canvas.getContext("2d")!;
    if (e.data.colors) {
      currentColors = e.data.colors.map(hexToRgb);
      targetColors = currentColors.map((c) => [...c]);
    }
    requestAnimationFrame(draw);
  } else if (e.data.type === "colors") {
    targetColors = (e.data.colors as string[]).map(hexToRgb);
    transitionStart = performance.now();
  }
};

export {};