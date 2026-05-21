export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}

export function distance(a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.hypot(dx, dy)
}

export function normalize(v) {
  const len = Math.hypot(v.x, v.y) || 1
  return { x: v.x / len, y: v.y / len }
}

export function createRng(seed = 1) {
  let s = seed >>> 0
  return {
    next() {
      s += 0x6d2b79f5
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    range(min, max) {
      return min + (max - min) * this.next()
    },
    int(min, max) {
      return Math.floor(this.range(min, max + 1))
    },
    pick(list) {
      return list[Math.floor(this.next() * list.length)]
    },
  }
}

export function cubicBezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t
  const tt = t * t
  const uu = u * u
  const uuu = uu * u
  const ttt = tt * t

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  }
}

export function cubicBezierTangent(p0, p1, p2, p3, t) {
  const u = 1 - t
  return normalize({
    x:
      3 * u * u * (p1.x - p0.x) +
      6 * u * t * (p2.x - p1.x) +
      3 * t * t * (p3.x - p2.x),
    y:
      3 * u * u * (p1.y - p0.y) +
      6 * u * t * (p2.y - p1.y) +
      3 * t * t * (p3.y - p2.y),
  })
}

export function polylineLength(points) {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += distance(points[i - 1], points[i])
  }
  return total
}

export function easeOutCubic(t) {
  const x = clamp(t, 0, 1)
  return 1 - (1 - x) ** 3
}

export function createRockSilhouette(rng, radius, sides = 9) {
  const count = Math.max(6, sides)
  const points = []
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2
    const wobble = 0.72 + rng.range(0, 0.34)
    points.push({
      x: Math.cos(angle) * radius * wobble,
      y: Math.sin(angle) * radius * wobble,
    })
  }
  return points
}

export function samplePath(points, t) {
  if (!points.length) return { x: 0, y: 0 }
  if (t <= 0) return points[0]
  if (t >= 1) return points[points.length - 1]

  const total = polylineLength(points)
  let target = total * t
  for (let i = 1; i < points.length; i += 1) {
    const seg = distance(points[i - 1], points[i])
    if (target <= seg) {
      const localT = seg === 0 ? 0 : target / seg
      return {
        x: lerp(points[i - 1].x, points[i].x, localT),
        y: lerp(points[i - 1].y, points[i].y, localT),
      }
    }
    target -= seg
  }
  return points[points.length - 1]
}
